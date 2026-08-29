/**
 * The map view, and the console side of the bridge.
 *
 * This page is not part of the console. It is served by the map driver, on the
 * driver's own origin, and it holds no API key and opens no socket: the
 * console forwards project state in with postMessage and this draws it. Three
 * messages go the other way - a handshake, a selection, and a proposed move.
 *
 * Everything from the parent is checked before it is believed: the origin
 * first, then the shape. The parent does the same in the other direction. The
 * two sides trust an origin, not each other.
 */
(function () {
  "use strict";

  var BRIDGE_VERSION = 2;
  var CAPABILITIES = { nodeDrag: true };

  var STATUS_COLOUR = {
    ok: "#0e7f8c",
    unknown: "#f7c948",
    "no-route": "#e74c5e",
  };

  var noticeBody = document.getElementById("notice-body");
  var notice = document.getElementById("notice");
  var legend = document.getElementById("legend");
  var hint = document.getElementById("hint");
  var toast = document.getElementById("toast");
  var statusBar = document.getElementById("status");
  var statusCounts = document.getElementById("status-counts");
  var statusProblem = document.getElementById("status-problem");

  function say(text) {
    noticeBody.textContent = text;
    notice.hidden = false;
  }

  /**
   * The standing line, bottom left: what this page has been given, and what
   * has gone wrong with it.
   *
   * The notice covers the map, so it is only for states where there is
   * nothing to look at. Everything after the basemap is up belongs here
   * instead - an operator can read it without losing the map, and an empty
   * map with a line under it saying why is a different thing entirely from an
   * empty map.
   */
  function setStatus(text) {
    statusCounts.textContent = text;
    statusBar.hidden = false;
  }

  function setProblem(text) {
    statusProblem.textContent = text;
    statusProblem.hidden = false;
    statusBar.hidden = false;
  }

  var toastTimer = null;
  function flash(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
    }, 4000);
  }

  /* ---------------------------------------------------------------------
     Who embedded this

     The console sets `referrerpolicy="origin"` on the frame precisely so this
     page can learn its origin and nothing more. No referrer means this page is
     not inside a console, and there is nobody to talk to: it renders nothing
     rather than guessing, because guessing here means posting a project's
     checkpoints at an origin nobody approved.
     --------------------------------------------------------------------- */

  var parentOrigin = null;
  try {
    if (document.referrer) parentOrigin = new URL(document.referrer).origin;
  } catch (err) {
    parentOrigin = null;
  }

  if (window.parent === window || !parentOrigin) {
    say(
      "This page is the map view of a Smart Checkpoints map driver. It draws " +
        "a project that an operator console sends it, and there is no console " +
        "here. Open it from the console instead: Project, then approve this " +
        "address, then Map.",
    );
    return;
  }

  /*
   * The library has to actually be here.
   *
   * Without this the first line of map setup is `mapboxgl.accessToken = ...`
   * against an undefined global, which throws, takes the rest of this file
   * with it, and leaves the page sitting on its opening notice forever - no
   * error on screen, no handshake, nothing for an operator to act on. The
   * console shows a blank map view and there is nothing anywhere that says
   * why. A missing script is a thing this page can see, so it says it.
   */
  if (typeof mapboxgl === "undefined") {
    say(
      "The map library did not load. This driver serves it from " +
        "/vendor/mapbox-gl.js - check that its npm install completed, and " +
        "that nothing in the browser is blocking scripts in this frame.",
    );
    return;
  }

  var config = window.SC_MAP || {};
  if (!config.token) {
    say(
      "This map driver has no Mapbox token, so there is no basemap to draw " +
        "on. Set MAPBOX_TOKEN in the driver's environment and restart it.",
    );
    return;
  }

  function post(type, payload) {
    window.parent.postMessage(
      { v: BRIDGE_VERSION, type: type, payload: payload },
      parentOrigin,
    );
  }

  /* ---------------------------------------------------------------------
     What the console has told us
     --------------------------------------------------------------------- */

  var nodes = new Map();
  var edges = new Map();
  var congestion = {};
  var selection = { kind: null, id: null };
  var framed = false;
  var received = false;

  function nodeFeature(node, position) {
    return {
      type: "Feature",
      id: node.node_id,
      geometry: {
        type: "Point",
        coordinates: position || [node.longitude, node.latitude],
      },
      properties: {
        node_id: node.node_id,
        label: String(node.id_in_project),
        flagged: node.flags && node.flags.length > 0 ? 1 : 0,
        reason: (node.flags || []).join(", "),
        selected:
          selection.kind === "node" && selection.id === node.node_id ? 1 : 0,
      },
    };
  }

  /**
   * An edge's shape: the road a distance driver measured, or the straight line
   * between its endpoints when nobody has measured one.
   *
   * The straight line is the honest fallback, and it is what the graph view
   * draws for every edge. An edge drawn straight on a basemap is saying "no
   * driver has told anyone where this road goes", which is true.
   */
  function edgeFeature(edge) {
    var from = nodes.get(edge.from_node_id);
    var to = nodes.get(edge.to_node_id);
    if (!from || !to) return null;

    var coordinates =
      edge.path && edge.path.coordinates && edge.path.coordinates.length > 1
        ? edge.path.coordinates
        : [
            [from.longitude, from.latitude],
            [to.longitude, to.latitude],
          ];

    return {
      type: "Feature",
      id: edge.connection_id,
      geometry: { type: "LineString", coordinates: coordinates },
      properties: {
        connection_id: edge.connection_id,
        status: edge.distance_status,
        colour: STATUS_COLOUR[edge.distance_status] || STATUS_COLOUR.unknown,
        distance: edge.distance,
        speed_limit: edge.speed_limit,
        measured: edge.path ? 1 : 0,
        flagged: edge.flags && edge.flags.length > 0 ? 1 : 0,
        congestion: congestion[edge.connection_id] || null,
        selected:
          selection.kind === "edge" && selection.id === edge.connection_id
            ? 1
            : 0,
      },
    };
  }

  function collection(features) {
    return { type: "FeatureCollection", features: features };
  }

  var dragging = null;

  /*
   * Whether there is anywhere to put the data yet.
   *
   * This used to be `map.isStyleLoaded()`, and that is not the same question.
   * `isStyleLoaded()` is false for as long as the style has any work
   * outstanding, and that includes every tile invalidated by the `jumpTo`
   * that `sc:init` performs - one message before the first `sc:graph`
   * arrives. So the snapshot landed while it was false, `render` returned
   * without a word, and nothing called it again: the console only sends
   * deltas after the snapshot, and a project that is not being edited has
   * none. The map framed the checkpoints correctly and drew nothing on them,
   * for as long as you left it open.
   *
   * What `setData` actually needs is the source, and the sources exist from
   * the `load` handler onwards. That is what this tracks.
   */
  var drawable = false;

  function render() {
    // Nothing is lost by returning here: the load handler renders
    // unconditionally the moment the sources exist, with whatever has
    // arrived by then.
    if (!drawable) return;

    var nodeFeatures = [];
    nodes.forEach(function (node) {
      var position =
        dragging && dragging.nodeId === node.node_id ? dragging.at : null;
      nodeFeatures.push(nodeFeature(node, position));
    });

    var edgeFeatures = [];
    edges.forEach(function (edge) {
      var feature = edgeFeature(edge);
      if (feature) edgeFeatures.push(feature);
    });

    map.getSource("nodes").setData(collection(nodeFeatures));
    map.getSource("edges").setData(collection(edgeFeatures));
    describe();
  }

  /**
   * The difference between "the console has not sent anything", "the console
   * sent an empty project" and "the console sent a project and it is drawn",
   * which are otherwise the same picture.
   */
  function describe() {
    if (!received) {
      setStatus("connected - waiting for the console to send this project");
      return;
    }
    if (nodes.size === 0) {
      setStatus("the console sent no checkpoints - this project has none yet");
      return;
    }

    var measured = 0;
    edges.forEach(function (edge) {
      if (edge.path) measured += 1;
    });

    setStatus(
      nodes.size +
        (nodes.size === 1 ? " checkpoint" : " checkpoints") +
        " \u00b7 " +
        edges.size +
        (edges.size === 1 ? " edge" : " edges") +
        " \u00b7 " +
        (edges.size === 0
          ? "no roads to draw"
          : measured === edges.size
            ? "all drawn on real roads"
            : measured +
              " drawn on real roads, " +
              (edges.size - measured) +
              " straight (no driver has measured them)"),
    );
  }

  function fit() {
    if (framed || nodes.size === 0) return;
    var bounds = new mapboxgl.LngLatBounds();
    nodes.forEach(function (node) {
      bounds.extend([node.longitude, node.latitude]);
    });
    map.fitBounds(bounds, { padding: 80, maxZoom: 16, duration: 0 });
    framed = true;
  }

  /* ---------------------------------------------------------------------
     The map
     --------------------------------------------------------------------- */

  mapboxgl.accessToken = config.token;

  var map;
  try {
    map = new mapboxgl.Map({
      container: "map",
      style: config.style || "mapbox://styles/mapbox/light-v11",
      center: [0, 0],
      zoom: 1,
      cooperativeGestures: false,
    });
    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "top-right",
    );
  } catch (err) {
    // Anything thrown here - no WebGL, a style URL that will not parse - would
    // otherwise be an uncaught error in a frame nobody is looking at the
    // console of.
    say("The map could not be created: " + (err && err.message ? err.message : err));
    return;
  }

  /*
   * A basemap that will not load is worth saying out loud.
   *
   * The usual cause is a token that is missing, expired or scoped to other
   * styles, and the usual symptom without this is an empty frame inside the
   * console with nothing to explain it. The bridge handshake is deliberately
   * not sent: a page that cannot draw is not ready for a graph.
   */
  var loaded = false;
  map.on("error", function (event) {
    var reason =
      (event && event.error && event.error.message) ||
      "Mapbox refused the request";

    if (!loaded) {
      say(
        "The basemap could not be loaded: " +
          reason +
          ". Check MAPBOX_TOKEN and MAPBOX_STYLE in the map driver, and that " +
          "this machine can reach api.mapbox.com.",
      );
      return;
    }

    // Once the map is up an error is a tile or a glyph, not a dead page.
    // Blanking a working map over one failed tile would be worse than the
    // problem; saying so under it is not.
    setProblem("basemap error: " + reason);
  });

  map.on("load", function () {
    loaded = true;
    notice.hidden = true;
    legend.hidden = false;
    hint.hidden = false;

    map.addSource("edges", { type: "geojson", data: collection([]) });
    map.addSource("nodes", { type: "geojson", data: collection([]) });

    map.addLayer({
      id: "edges-selected",
      type: "line",
      source: "edges",
      filter: ["==", ["get", "selected"], 1],
      paint: {
        "line-color": "#19c4d8",
        "line-width": 10,
        "line-opacity": 0.25,
        "line-blur": 1,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    /* Two layers rather than one, because a dash pattern cannot be driven by
       data. An edge with no usable distance is drawn broken, the same way the
       graph view draws it: it is not enforcing anything. */
    map.addLayer({
      id: "edges-solid",
      type: "line",
      source: "edges",
      filter: ["==", ["get", "status"], "ok"],
      paint: { "line-color": ["get", "colour"], "line-width": 3.5 },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    map.addLayer({
      id: "edges-dashed",
      type: "line",
      source: "edges",
      filter: ["!=", ["get", "status"], "ok"],
      paint: {
        "line-color": ["get", "colour"],
        "line-width": 3,
        "line-dasharray": [2, 2],
      },
      layout: { "line-cap": "butt", "line-join": "round" },
    });

    map.addLayer({
      id: "nodes-flagged",
      type: "circle",
      source: "nodes",
      filter: ["==", ["get", "flagged"], 1],
      paint: {
        "circle-radius": 16,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#f7c948",
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "nodes",
      type: "circle",
      source: "nodes",
      paint: {
        "circle-radius": 10,
        "circle-color": "#ffffff",
        "circle-stroke-color": [
          "case",
          ["==", ["get", "selected"], 1],
          "#19c4d8",
          "#1e2628",
        ],
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "nodes-label",
      type: "symbol",
      source: "nodes",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#1e2628" },
    });

    // The sources exist from here on, so anything that arrived early and
    // could not be drawn is drawn now.
    drawable = true;
    render();
    fit();

    // Only once the map can actually draw. Announcing readiness before that
    // means the first snapshot arrives with nowhere to put it.
    post("sc:ready", {
      protocolVersion: BRIDGE_VERSION,
      capabilities: CAPABILITIES,
    });
  });

  /* --------------------------------------------------------- interaction */

  var popup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
  });

  function metres(value) {
    if (value === null || value === undefined) return "not measured";
    return value >= 1000
      ? (value / 1000).toFixed(2) + " km"
      : Math.round(value) + " m";
  }

  map.on("mousemove", "edges-solid", edgeHover);
  map.on("mousemove", "edges-dashed", edgeHover);
  function edgeHover(event) {
    var props = event.features[0].properties;
    map.getCanvas().style.cursor = "pointer";
    popup
      .setLngLat(event.lngLat)
      .setHTML(
        "<strong>Edge " +
          props.connection_id +
          "</strong>" +
          metres(props.distance === "null" ? null : Number(props.distance)) +
          " &middot; " +
          props.speed_limit +
          " km/h<br>" +
          (props.status === "ok"
            ? props.measured === 1
              ? "measured by a driver"
              : "distance set by hand"
            : props.status === "no-route"
              ? "no road here - not enforcing"
              : "no distance - not enforcing"),
      )
      .addTo(map);
  }

  map.on("mouseleave", "edges-solid", clearHover);
  map.on("mouseleave", "edges-dashed", clearHover);
  map.on("mouseleave", "nodes", clearHover);
  function clearHover() {
    if (dragging) return;
    map.getCanvas().style.cursor = "";
    popup.remove();
  }

  map.on("mousemove", "nodes", function (event) {
    if (dragging) return;
    var props = event.features[0].properties;
    map.getCanvas().style.cursor = "grab";
    popup
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(
        "<strong>Checkpoint " +
          props.label +
          "</strong>" +
          (props.flagged === 1
            ? props.reason + "<br>"
            : "") +
          "drag to correct its position",
      )
      .addTo(map);
  });

  map.on("click", "nodes", function (event) {
    post("sc:select", {
      kind: "node",
      id: event.features[0].properties.node_id,
    });
  });
  map.on("click", "edges-solid", selectEdge);
  map.on("click", "edges-dashed", selectEdge);
  function selectEdge(event) {
    post("sc:select", {
      kind: "edge",
      id: event.features[0].properties.connection_id,
    });
  }

  map.on("click", function (event) {
    var hits = map.queryRenderedFeatures(event.point, {
      layers: ["nodes", "edges-solid", "edges-dashed"],
    });
    if (hits.length === 0) post("sc:select", { kind: null, id: null });
  });

  /* ------------------------------------------------------------ dragging */

  /*
   * Dragging a checkpoint here is a proposal, not a write.
   *
   * This is where a bad GPS fix becomes obvious - a camera in the middle of a
   * building is visible on a basemap and invisible on a blank one - so it is
   * worth supporting. But moving a camera throws away every distance measured
   * to it, and that decision belongs to the console, which asks. On drop the
   * checkpoint goes back where it was and stays there until the console says
   * otherwise, because until then it has not moved.
   */
  map.on("mousedown", "nodes", function (event) {
    event.preventDefault(); // stops the map panning under the drag
    dragging = {
      nodeId: event.features[0].properties.node_id,
      at: [event.lngLat.lng, event.lngLat.lat],
    };
    map.getCanvas().style.cursor = "grabbing";
    popup.remove();
  });

  map.on("mousemove", function (event) {
    if (!dragging) return;
    dragging.at = [event.lngLat.lng, event.lngLat.lat];
    render();
  });

  map.on("mouseup", function (event) {
    if (!dragging) return;
    var nodeId = dragging.nodeId;
    var at = [event.lngLat.lng, event.lngLat.lat];
    dragging = null;
    map.getCanvas().style.cursor = "";
    render();

    post("sc:node-moved", {
      nodeId: nodeId,
      latitude: at[1],
      longitude: at[0],
    });
    flash("Move proposed - confirm it in the console");
  });

  /* ---------------------------------------------------------------------
     The bridge

     Everything below arrives from the console. The origin is checked first,
     then the source, then the shape - a message that fails any of the three
     is dropped without a word, because a page that argues with whatever is
     posting at it is a page that can be kept busy.
     --------------------------------------------------------------------- */

  function isObject(value) {
    return typeof value === "object" && value !== null;
  }

  function readNode(value) {
    if (!isObject(value)) return null;
    if (!Number.isInteger(value.node_id)) return null;
    if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) {
      return null;
    }
    if (Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) {
      return null;
    }
    return {
      node_id: value.node_id,
      id_in_project: value.id_in_project,
      latitude: value.latitude,
      longitude: value.longitude,
      flags: Array.isArray(value.flags) ? value.flags : [],
    };
  }

  function readEdge(value) {
    if (!isObject(value)) return null;
    if (!Number.isInteger(value.connection_id)) return null;
    var path = null;
    if (
      isObject(value.path) &&
      value.path.type === "LineString" &&
      Array.isArray(value.path.coordinates)
    ) {
      path = value.path;
    }
    return {
      connection_id: value.connection_id,
      from_node_id: value.from_node_id,
      to_node_id: value.to_node_id,
      distance: typeof value.distance === "number" ? value.distance : null,
      speed_limit: value.speed_limit,
      distance_status: value.distance_status,
      path: path,
      flags: Array.isArray(value.flags) ? value.flags : [],
    };
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== parentOrigin) return;
    if (event.source !== window.parent) return;

    var data = event.data;
    if (!isObject(data) || data.v !== BRIDGE_VERSION) return;
    var payload = isObject(data.payload) ? data.payload : null;

    switch (data.type) {
      case "sc:init":
        if (
          payload &&
          isObject(payload.origin) &&
          Number.isFinite(payload.origin.lat) &&
          Number.isFinite(payload.origin.lng) &&
          !framed
        ) {
          map.jumpTo({ center: [payload.origin.lng, payload.origin.lat], zoom: 12 });
        }
        break;

      case "sc:graph": {
        if (!payload) return;
        received = true;
        nodes.clear();
        edges.clear();
        (payload.nodes || []).forEach(function (raw) {
          var node = readNode(raw);
          if (node) nodes.set(node.node_id, node);
        });
        (payload.edges || []).forEach(function (raw) {
          var edge = readEdge(raw);
          if (edge) edges.set(edge.connection_id, edge);
        });
        render();
        fit();
        break;
      }

      case "sc:node-updated": {
        if (!payload) return;
        var node = readNode(payload.node);
        if (!node) return;
        nodes.set(node.node_id, node);
        render();
        break;
      }

      case "sc:edge-updated": {
        if (!payload) return;
        var edge = readEdge(payload.edge);
        if (!edge) return;
        edges.set(edge.connection_id, edge);
        render();
        break;
      }

      case "sc:congestion":
        if (!payload) return;
        congestion = payload;
        render();
        break;

      case "sc:diagnostics":
        // Flags already travel on each node and edge; this is the same answer
        // arriving as a whole, and re-reading it here would be two sources for
        // one fact. Kept as a no-op rather than pretended away.
        break;

      case "sc:selection":
        if (!payload) return;
        selection =
          payload.kind === "node" || payload.kind === "edge"
            ? { kind: payload.kind, id: payload.id }
            : { kind: null, id: null };
        render();
        break;

      default:
        break;
    }
  });
})();
