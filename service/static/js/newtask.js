(function () {
    'use strict';

    var currentImageFile = null;
    var topologyData = null; // { walls, shelves, image_width, image_height }
    var gridGeometry = null; // { inX, inY, inW, inH, nx, ny, cellW, cellH }
    var graphData = null;    // { nodes: [{id,i,j}], edges: [{from,to,length}], meta }
    var droneCell = null;    // { i, j } или null
    var axisYDirection = null; // { di, dj } — направление оси Y от дрона (соседняя клетка), или null
    var droneImage = new Image();
    droneImage.src = '/drone-icon.png';

    const fileInput = document.getElementById('fileInput');
    const fileDisplay = document.getElementById('fileDisplay');
    const browseBtn = document.getElementById('browseBtn');
    const uploadFileBtn = document.getElementById('uploadFileBtn');
    const uploadZone = document.getElementById('uploadZone');
    const imageInput = document.getElementById('imageInput');
    const uploadPreview = document.getElementById('uploadPreview');
    const previewImage = document.getElementById('previewImage');
    const mapWrapper = document.getElementById('mapWrapper');
    const mapOverlay = document.getElementById('mapOverlay');
    const analyzeTopologyBtn = document.getElementById('analyzeTopologyBtn');
    const storageCells = document.getElementById('storageCells');
    const storageShelves = document.getElementById('storageShelves');
    const shelvesBlock = document.getElementById('shelvesBlock');
    const shelfLevelsCount = document.getElementById('shelfLevelsCount');
    const shelfLevelsList = document.getElementById('shelfLevelsList');
    const buildGraphBtn = document.getElementById('buildGraphBtn');
    const loadGraphBtn = document.getElementById('loadGraphBtn');
    const mapGraphOverlay = document.getElementById('mapGraphOverlay');
    const buildRouteBtn = document.getElementById('buildRouteBtn');
    const routeStats = document.getElementById('routeStats');
    const startSimulationBtn = document.getElementById('startSimulationBtn');
    const stopSimulationBtn = document.getElementById('stopSimulationBtn');
    const startDroneBtn = document.getElementById('startDroneBtn');
    const landDroneBtn = document.getElementById('landDroneBtn');

    var flyoverRoute = null;
    var flyoverRouteLength = 0;
    var flyoverReturnStartIndex = null;
    var simulationInterval = null;
    var nodeQrData = {};
    var videoStreamInterval = null;

    function showPreview(file) {
        if (!file || !file.type.startsWith('image/')) return;
        currentImageFile = file;
        var reader = new FileReader();
        reader.onload = function (e) {
            previewImage.src = e.target.result;
            if (uploadZone && uploadPreview) {
                uploadZone.classList.add('hidden');
                uploadPreview.classList.remove('hidden');
            }
            if (analyzeTopologyBtn) analyzeTopologyBtn.disabled = false;
            topologyData = null;
            gridGeometry = null;
            graphData = null;
            flyoverRoute = null;
            flyoverRouteLength = 0;
            flyoverReturnStartIndex = null;
            droneCell = null;
            axisYDirection = null;
            updateGraphButtons();
            resizeOverlay();
        };
        reader.readAsDataURL(file);
    }

    function resizeOverlay() {
        if (!mapOverlay || !previewImage || !previewImage.src) return;
        var img = previewImage;
        var w = img.offsetWidth;
        var h = img.offsetHeight;
        var resized = false;
        if (mapOverlay.width !== w || mapOverlay.height !== h) {
            mapOverlay.width = w;
            mapOverlay.height = h;
            resized = true;
        }
        if (mapGraphOverlay && (mapGraphOverlay.width !== w || mapGraphOverlay.height !== h)) {
            mapGraphOverlay.width = w;
            mapGraphOverlay.height = h;
            resized = true;
        }
        if (resized) drawOverlay();
    }

    function drawGraphLayer() {
        if (!mapGraphOverlay) return;
        var ctx = mapGraphOverlay.getContext('2d');
        ctx.clearRect(0, 0, mapGraphOverlay.width, mapGraphOverlay.height);
        if (!gridGeometry || !graphData || !graphData.nodes || !graphData.nodes.length) return;
        drawGraph(ctx, gridGeometry, graphData, nodeQrData);
    }

    function fetchNodeQrData() {
        fetch('/api/nodes/qr')
            .then(function (res) { return res.ok ? res.json() : {}; })
            .then(function (data) {
                nodeQrData = data && typeof data === 'object' ? data : {};
                drawGraphLayer();
            })
            .catch(function () {});
    }

    function drawOverlay() {
        if (!mapOverlay || !topologyData) {
            gridGeometry = null;
            if (mapOverlay) mapOverlay.classList.remove('map-overlay--interactive');
            drawGraphLayer();
            return;
        }
        var img = previewImage;
        if (img && img.src) resizeOverlay();
        var dw = img.offsetWidth;
        var dh = img.offsetHeight;
        if (!dw || !dh) {
            gridGeometry = null;
            drawGraphLayer();
            return;
        }
        var iw = topologyData.image_width;
        var ih = topologyData.image_height;
        var sx = dw / iw;
        var sy = dh / ih;

        var ctx = mapOverlay.getContext('2d');
        ctx.clearRect(0, 0, mapOverlay.width, mapOverlay.height);

        var shelves = topologyData.shelves || [];
        ctx.fillStyle = 'rgba(120, 120, 120, 0.5)';
        ctx.strokeStyle = 'rgba(80, 80, 80, 0.8)';
        ctx.lineWidth = 1;
        for (var i = 0; i < shelves.length; i++) {
            var s = shelves[i];
            var x = s[0] * sx;
            var y = s[1] * sy;
            var w = s[2] * sx;
            var h = s[3] * sy;
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
        }

        var walls = topologyData.walls;
        if (walls && walls.length >= 4) {
            var lengthM = parseFloat(document.getElementById('buildingLength').value) || 10;
            var widthM = parseFloat(document.getElementById('buildingWidth').value) || 10;
            var scaleX = parseFloat(document.getElementById('scaleX').value) || 1;
            var scaleY = parseFloat(document.getElementById('scaleY').value) || 1;
            var nx = Math.max(1, Math.floor(lengthM / scaleX));
            var ny = Math.max(1, Math.floor(widthM / scaleY));
            var wallX = walls[0] * sx;
            var wallY = walls[1] * sy;
            var wallW = walls[2] * sx;
            var wallH = walls[3] * sy;
            var inset = Math.min(wallW, wallH) * 0.02;
            var inX = wallX + inset;
            var inY = wallY + inset;
            var inW = wallW - 2 * inset;
            var inH = wallH - 2 * inset;
            if (inW < 1 || inH < 1) { inX = wallX; inY = wallY; inW = wallW; inH = wallH; }
            var cellW = inW / nx;
            var cellH = inH / ny;
            gridGeometry = { inX: inX, inY: inY, inW: inW, inH: inH, nx: nx, ny: ny, cellW: cellW, cellH: cellH };
            mapOverlay.classList.add('map-overlay--interactive');

            ctx.strokeStyle = 'rgba(33, 170, 190, 0.4)';
            ctx.lineWidth = 1;
            for (var i = 1; i < nx; i++) {
                var x = inX + i * cellW;
                ctx.beginPath();
                ctx.moveTo(x, inY);
                ctx.lineTo(x, inY + inH);
                ctx.stroke();
            }
            for (var j = 1; j < ny; j++) {
                var y = inY + j * cellH;
                ctx.beginPath();
                ctx.moveTo(inX, y);
                ctx.lineTo(inX + inW, y);
                ctx.stroke();
            }

            if (droneCell != null && droneCell.i >= 0 && droneCell.i < nx && droneCell.j >= 0 && droneCell.j < ny && droneImage.complete && droneImage.naturalWidth) {
                var cx = inX + (droneCell.i + 0.5) * cellW;
                var cy = inY + (droneCell.j + 0.5) * cellH;
                var size = Math.min(cellW, cellH) * 0.85;
                var dx = cx - size / 2;
                var dy = cy - size / 2;
                ctx.drawImage(droneImage, dx, dy, size, size);
            }
            if (droneCell != null && axisYDirection != null && axisYDirection.di != null && axisYDirection.dj != null &&
                droneCell.i >= 0 && droneCell.i < nx && droneCell.j >= 0 && droneCell.j < ny) {
                var cx2 = inX + (droneCell.i + 0.5) * cellW;
                var cy2 = inY + (droneCell.j + 0.5) * cellH;
                var di = axisYDirection.di;
                var dj = axisYDirection.dj;
                var len = Math.min(cellW, cellH) * 1.1;
                var ex = cx2 + di * len;
                var ey = cy2 + dj * len;
                ctx.strokeStyle = 'rgba(255, 200, 40, 0.95)';
                ctx.fillStyle = 'rgba(255, 200, 40, 0.95)';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(cx2, cy2);
                ctx.lineTo(ex, ey);
                ctx.stroke();
                var headLen = Math.min(cellW, cellH) * 0.35;
                var angle = Math.atan2(dj, di);
                ctx.beginPath();
                ctx.moveTo(ex, ey);
                ctx.lineTo(ex - headLen * Math.cos(angle - 0.4), ey - headLen * Math.sin(angle - 0.4));
                ctx.lineTo(ex - headLen * Math.cos(angle + 0.4), ey - headLen * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.font = '12px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(40, 40, 40, 0.95)';
                ctx.fillText('Y', ex + di * headLen * 0.8, ey + dj * headLen * 0.8);
            }
        } else {
            gridGeometry = null;
            mapOverlay.classList.remove('map-overlay--interactive');
        }
        drawGraphLayer();
    }

    function nodeId(i, j) {
        return i + '_' + j;
    }

    function cellCenterPX(g, i, j) {
        if (!g) return { x: 0, y: 0 };
        var x = g.inX + (i + 0.5) * g.cellW;
        var y = g.inY + (j + 0.5) * g.cellH;
        return { x: x, y: y };
    }

    function buildGraph() {
        if (!topologyData || !topologyData.walls || topologyData.walls.length < 4) return null;
        var walls = topologyData.walls;
        var shelves = topologyData.shelves || [];
        var iw = topologyData.image_width;
        var ih = topologyData.image_height;
        var lengthM = parseFloat(document.getElementById('buildingLength').value) || 10;
        var widthM = parseFloat(document.getElementById('buildingWidth').value) || 10;
        var scaleX = parseFloat(document.getElementById('scaleX').value) || 1;
        var scaleY = parseFloat(document.getElementById('scaleY').value) || 1;
        var nx = Math.max(1, Math.floor(lengthM / scaleX));
        var ny = Math.max(1, Math.floor(widthM / scaleY));
        var ww = walls[2];
        var wh = walls[3];
        var inset = Math.min(ww, wh) * 0.02;
        var inX = walls[0] + inset;
        var inY = walls[1] + inset;
        var inW = Math.max(1, walls[2] - 2 * inset);
        var inH = Math.max(1, walls[3] - 2 * inset);
        var cellW = inW / nx;
        var cellH = inH / ny;

        function centerInShelf(ci, cj) {
            var cx = inX + (ci + 0.5) * cellW;
            var cy = inY + (cj + 0.5) * cellH;
            for (var k = 0; k < shelves.length; k++) {
                var s = shelves[k];
                var sx = s[0];
                var sy = s[1];
                var sw = s[2];
                var sh = s[3];
                if (cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh) return true;
            }
            return false;
        }

        function buildNodesAndWalkable(skipShelfCheck) {
            var walkable = {};
            var nodes = [];
            for (var i = 0; i < nx; i++) {
                for (var j = 0; j < ny; j++) {
                    if (!skipShelfCheck && centerInShelf(i, j)) continue;
                    var id = nodeId(i, j);
                    walkable[id] = true;
                    nodes.push({ id: id, i: i, j: j });
                }
            }
            return { walkable: walkable, nodes: nodes };
        }

        var useShelfBlocking = !!(storageShelves && storageShelves.checked);
        var r = useShelfBlocking ? buildNodesAndWalkable(false) : buildNodesAndWalkable(true);
        var walkable = r.walkable;
        var nodes = r.nodes;

        var edges = [];
        var dirs = [[1, 0, scaleX], [-1, 0, scaleX], [0, 1, scaleY], [0, -1, scaleY]];
        for (var n = 0; n < nodes.length; n++) {
            var u = nodes[n];
            var i = u.i;
            var j = u.j;
            for (var d = 0; d < dirs.length; d++) {
                var di = dirs[d][0];
                var dj = dirs[d][1];
                var len = dirs[d][2];
                var ni = i + di;
                var nj = j + dj;
                if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
                var vid = nodeId(ni, nj);
                if (!walkable[vid]) continue;
                var from = u.id;
                var to = vid;
                if (from > to) { var t = from; from = to; to = t; }
                var dupe = false;
                for (var e = 0; e < edges.length; e++) {
                    if (edges[e].from === from && edges[e].to === to) { dupe = true; break; }
                }
                if (!dupe) edges.push({ from: from, to: to, length: len });
            }
        }

        var meta = { nx: nx, ny: ny, scaleX: scaleX, scaleY: scaleY, imageWidth: iw, imageHeight: ih, walls: walls };
        graphData = { nodes: nodes, edges: edges, meta: meta };
        return graphData;
    }

    function drawGraph(ctx, g, data, qrData) {
        if (!ctx || !g || !data || !data.nodes || !data.nodes.length) return;
        var nodeMap = {};
        for (var n = 0; n < data.nodes.length; n++) {
            var u = data.nodes[n];
            if (u.i >= 0 && u.i < g.nx && u.j >= 0 && u.j < g.ny) nodeMap[u.id] = u;
        }
        var radius = Math.max(2, Math.min(g.cellW, g.cellH) * 0.2);
        var edges = data.edges || [];
        ctx.strokeStyle = 'rgba(33, 170, 190, 0.9)';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(33, 170, 190, 0.25)';
        for (var e = 0; e < edges.length; e++) {
            var edge = edges[e];
            var a = nodeMap[edge.from];
            var b = nodeMap[edge.to];
            if (!a || !b) continue;
            var pa = cellCenterPX(g, a.i, a.j);
            var pb = cellCenterPX(g, b.i, b.j);
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
            var mx = (pa.x + pb.x) / 2;
            var my = (pa.y + pb.y) / 2;
            var lab = (Math.round(edge.length * 100) / 100) + ' м';
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(26, 44, 63, 0.95)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 2.5;
            ctx.strokeText(lab, mx, my);
            ctx.fillText(lab, mx, my);
        }
        ctx.strokeStyle = 'rgba(26, 44, 63, 0.8)';
        ctx.lineWidth = 1;
        for (var n = 0; n < data.nodes.length; n++) {
            var u = data.nodes[n];
            if (u.i < 0 || u.i >= g.nx || u.j < 0 || u.j >= g.ny) continue;
            var p = cellCenterPX(g, u.i, u.j);
            if (qrData && qrData[u.id]) {
                ctx.fillStyle = 'rgba(240, 160, 40, 0.85)';
            } else {
                ctx.fillStyle = 'rgba(33, 170, 190, 0.6)';
            }
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    function updateGraphButtons() {
        var ok = !!(topologyData && topologyData.walls && topologyData.walls.length >= 4);
        if (buildGraphBtn) buildGraphBtn.disabled = !ok;
        if (loadGraphBtn) loadGraphBtn.disabled = !ok;
        updateRouteButtons();
    }

    function dijkstra(adj, startId) {
        var dist = {};
        var prev = {};
        var nodes = Object.keys(adj);
        for (var n = 0; n < nodes.length; n++) {
            dist[nodes[n]] = Infinity;
            prev[nodes[n]] = null;
        }
        dist[startId] = 0;
        var unvisited = nodes.slice();
        while (unvisited.length) {
            var u = null;
            var best = Infinity;
            for (var i = 0; i < unvisited.length; i++) {
                if (dist[unvisited[i]] < best) {
                    best = dist[unvisited[i]];
                    u = unvisited[i];
                }
            }
            if (u === null || best === Infinity) break;
            unvisited.splice(unvisited.indexOf(u), 1);
            var neighbors = adj[u] || [];
            for (var k = 0; k < neighbors.length; k++) {
                var v = neighbors[k].id;
                var len = neighbors[k].len;
                var alt = dist[u] + len;
                if (alt < dist[v]) {
                    dist[v] = alt;
                    prev[v] = u;
                }
            }
        }
        return { dist: dist, prev: prev };
    }

    function pathFromPrev(prev, startId, endId) {
        var path = [];
        var cur = endId;
        while (cur) {
            path.unshift(cur);
            cur = prev[cur];
        }
        return path;
    }

    function buildFlyoverRoute() {
        if (!graphData || !graphData.nodes || !graphData.nodes.length || !graphData.edges) return;
        var nodes = graphData.nodes;
        var edges = graphData.edges;
        var adj = {};
        for (var n = 0; n < nodes.length; n++) adj[nodes[n].id] = [];
        for (var e = 0; e < edges.length; e++) {
            var edge = edges[e];
            adj[edge.from].push({ id: edge.to, len: edge.length });
            adj[edge.to].push({ id: edge.from, len: edge.length });
        }
        var startId = null;
        if (droneCell != null) {
            var dcId = nodeId(droneCell.i, droneCell.j);
            if (adj[dcId]) startId = dcId;
        }
        if (!startId) startId = nodes[0].id;
        var order = [startId];
        var remaining = [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].id !== startId) remaining.push(nodes[i].id);
        }
        while (remaining.length) {
            var fromId = order[order.length - 1];
            var result = dijkstra(adj, fromId);
            var bestId = null;
            var bestDist = Infinity;
            for (var j = 0; j < remaining.length; j++) {
                var d = result.dist[remaining[j]];
                if (d < bestDist) {
                    bestDist = d;
                    bestId = remaining[j];
                }
            }
            if (!bestId) break;
            order.push(bestId);
            remaining.splice(remaining.indexOf(bestId), 1);
        }
        var fullPath = [];
        var totalLen = 0;
        for (var s = 0; s < order.length; s++) {
            if (s === 0) {
                fullPath.push(order[0]);
            } else {
                var res = dijkstra(adj, order[s - 1]);
                var seg = pathFromPrev(res.prev, order[s - 1], order[s]);
                for (var p = 1; p < seg.length; p++) {
                    fullPath.push(seg[p]);
                    var prevNode = seg[p - 1];
                    var currNode = seg[p];
                    for (var ee = 0; ee < adj[prevNode].length; ee++) {
                        if (adj[prevNode][ee].id === currNode) {
                            totalLen += adj[prevNode][ee].len;
                            break;
                        }
                    }
                }
            }
        }
        var lastId = order[order.length - 1];
        flyoverReturnStartIndex = lastId !== startId ? fullPath.length : null;
        if (lastId !== startId) {
            var resBack = dijkstra(adj, lastId);
            var segBack = pathFromPrev(resBack.prev, lastId, startId);
            for (var pb = 1; pb < segBack.length; pb++) {
                fullPath.push(segBack[pb]);
                var prevNode = segBack[pb - 1];
                var currNode = segBack[pb];
                for (var eeb = 0; eeb < adj[prevNode].length; eeb++) {
                    if (adj[prevNode][eeb].id === currNode) {
                        totalLen += adj[prevNode][eeb].len;
                        break;
                    }
                }
            }
        }
        flyoverRoute = fullPath;
        flyoverRouteLength = totalLen;
    }

    function updateRouteStats() {
        if (!routeStats) return;
        if (!flyoverRoute || !flyoverRoute.length) {
            routeStats.textContent = '—';
            return;
        }
        routeStats.textContent = 'Узлов: ' + flyoverRoute.length + ', длина маршрута: ' + (Math.round(flyoverRouteLength * 100) / 100) + ' м';
    }

    function updateRouteButtons() {
        var hasGraph = !!(graphData && graphData.nodes && graphData.nodes.length);
        if (buildRouteBtn) buildRouteBtn.disabled = !hasGraph;
        var hasRoute = !!(flyoverRoute && flyoverRoute.length);
        if (startSimulationBtn) startSimulationBtn.disabled = !hasRoute;
        if (stopSimulationBtn) stopSimulationBtn.disabled = true;
        if (startDroneBtn) startDroneBtn.disabled = !hasRoute;
        updateRouteStats();
    }

    if (previewImage) {
        previewImage.addEventListener('load', function () {
            resizeOverlay();
        });
    }

    droneImage.onload = function () { drawOverlay(); };

    var mapClickTimeout = null;
    if (mapOverlay && mapWrapper) {
        mapOverlay.addEventListener('click', function (e) {
            if (!gridGeometry) return;
            var rect = mapOverlay.getBoundingClientRect();
            var scaleX = mapOverlay.width / rect.width;
            var scaleY = mapOverlay.height / rect.height;
            var px = (e.clientX - rect.left) * scaleX;
            var py = (e.clientY - rect.top) * scaleY;
            var g = gridGeometry;
            var ci = Math.floor((px - g.inX) / g.cellW);
            var cj = Math.floor((py - g.inY) / g.cellH);
            if (ci < 0 || ci >= g.nx || cj < 0 || cj >= g.ny) return;
            var nodeId = ci + '_' + cj;
            var isGraphNode = graphData && graphData.nodes && graphData.nodes.some(function (n) { return n.id === nodeId; });
            var viewQrMode = document.querySelector('input[name="mapClickMode"]:checked');
            if (viewQrMode && viewQrMode.value === 'view_qr' && isGraphNode) {
                if (mapClickTimeout) clearTimeout(mapClickTimeout);
                mapClickTimeout = null;
                openNodeQrModal(nodeId, ci, cj);
                return;
            }
            if (mapClickTimeout) clearTimeout(mapClickTimeout);
            mapClickTimeout = setTimeout(function () {
                mapClickTimeout = null;
                droneCell = { i: ci, j: cj };
                drawOverlay();
            }, 250);
        });
        mapOverlay.addEventListener('dblclick', function (e) {
            e.preventDefault();
            if (mapClickTimeout) {
                clearTimeout(mapClickTimeout);
                mapClickTimeout = null;
            }
            if (!gridGeometry || !droneCell) return;
            var rect = mapOverlay.getBoundingClientRect();
            var scaleX = mapOverlay.width / rect.width;
            var scaleY = mapOverlay.height / rect.height;
            var px = (e.clientX - rect.left) * scaleX;
            var py = (e.clientY - rect.top) * scaleY;
            var g = gridGeometry;
            var ci = Math.floor((px - g.inX) / g.cellW);
            var cj = Math.floor((py - g.inY) / g.cellH);
            if (ci < 0 || ci >= g.nx || cj < 0 || cj >= g.ny) return;
            var di = ci - droneCell.i;
            var dj = cj - droneCell.j;
            if (Math.abs(di) + Math.abs(dj) !== 1) return;
            axisYDirection = { di: di, dj: dj };
            drawOverlay();
        });
    }

    function openNodeQrModal(nodeId, ci, cj) {
        var titleEl = document.getElementById('nodeQrModalTitle');
        var contentEl = document.getElementById('nodeQrModalContent');
        var modal = document.getElementById('nodeQrModal');
        if (titleEl) titleEl.textContent = 'Узел (' + ci + ', ' + cj + ')';
        if (contentEl) contentEl.textContent = (nodeQrData[nodeId] && nodeQrData[nodeId].trim()) ? nodeQrData[nodeId] : 'QR не распознан';
        if (modal) modal.classList.remove('hidden');
    }

    function closeNodeQrModal() {
        var modal = document.getElementById('nodeQrModal');
        if (modal) modal.classList.add('hidden');
    }

    var videoStreamActive = false;

    function startVideoStream() {
        var canvas = document.getElementById('videoStreamFrame');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        videoStreamActive = true;

        function drawQrBoxes(qrList) {
            if (!qrList || !qrList.length) return;
            ctx.strokeStyle = 'rgba(0, 255, 100, 0.9)';
            ctx.lineWidth = 3;
            ctx.font = '14px system-ui, sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.strokeStyle = 'rgba(0, 255, 100, 0.95)';
            for (var q = 0; q < qrList.length; q++) {
                var qr = qrList[q];
                var pts = qr.points;
                if (!pts || pts.length < 3) continue;
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
                ctx.closePath();
                ctx.stroke();
                if (qr.data) {
                    var mx = 0, my = 0;
                    for (var ki = 0; ki < pts.length; ki++) { mx += pts[ki][0]; my += pts[ki][1]; }
                    mx /= pts.length;
                    my /= pts.length;
                    ctx.fillStyle = 'rgba(0, 255, 100, 0.95)';
                    var txt = qr.data.length > 32 ? qr.data.substring(0, 30) + '…' : qr.data;
                    ctx.fillText(txt, mx, my + 2);
                }
            }
        }

        function updateDebug(d) {
            var el = document.getElementById('videoStreamDebug');
            if (!el) return;
            if (!d || typeof d !== 'object') {
                el.textContent = '';
                el.classList.remove('modal-video-debug--error');
                return;
            }
            var lines = [];
            if (d.cv_version) lines.push('OpenCV: ' + d.cv_version);
            if (d.original_size) lines.push('Кадр (ориг.): ' + d.original_size[0] + '×' + d.original_size[1]);
            if (d.resized) lines.push('Кадр (вывод): ' + d.resized[0] + '×' + d.resized[1]);
            if (d.detector_used) lines.push('Детектор: ' + d.detector_used);
            if (d.detector) lines.push('Детектор (старый): ' + d.detector);
            if (d.pyzbar_available !== undefined) lines.push('pyzbar: ' + (d.pyzbar_available ? 'да' : 'нет'));
            if (d.pyzbar_count !== undefined) lines.push('pyzbar_count: ' + d.pyzbar_count);
            if (d.pyzbar_error) lines.push('pyzbar_error: ' + d.pyzbar_error);
            if (d.retval !== undefined) lines.push('retval: ' + d.retval);
            if (d.decoded_len !== undefined) lines.push('decoded_len: ' + d.decoded_len);
            if (d.points_len !== undefined) lines.push('points_len: ' + d.points_len);
            if (d.qr_count !== undefined) lines.push('QR найдено: ' + d.qr_count);
            if (d.no_codes) lines.push('(коды не найдены)');
            if (d.camera) lines.push('Камера: ' + d.camera);
            if (d.frame) lines.push('Кадр: ' + d.frame);
            if (d.cv) lines.push('CV: ' + d.cv);
            if (d.skip_reason) lines.push('Пропуск: ' + d.skip_reason);
            if (d.multi_error) lines.push('multi_error: ' + d.multi_error);
            if (d.single_error) lines.push('single_error: ' + d.single_error);
            if (d.opencv_detector) lines.push('opencv: ' + d.opencv_detector);
            if (d.opencv_retval !== undefined) lines.push('opencv_retval: ' + d.opencv_retval);
            if (d.opencv_multi_error) lines.push('opencv_multi_err: ' + d.opencv_multi_error);
            if (d.opencv_single_data !== undefined) lines.push('opencv_data: ' + (d.opencv_single_data ? '«' + d.opencv_single_data + '»' : '—'));
            if (d.single_data !== undefined) lines.push('single_data: ' + (d.single_data ? '«' + d.single_data + '»' : '—'));
            if (d.bbox_is_none !== undefined) lines.push('bbox_is_none: ' + d.bbox_is_none);
            if (d.bbox_shape) lines.push('bbox_shape: ' + JSON.stringify(d.bbox_shape));
            if (d.bbox_size !== undefined) lines.push('bbox_size: ' + d.bbox_size);
            if (d.exception) lines.push('Ошибка: ' + d.exception);
            if (d.traceback) lines.push('\n' + d.traceback);
            el.textContent = lines.join(' | ');
            if (d.exception || d.multi_error || d.single_error) el.classList.add('modal-video-debug--error');
            else el.classList.remove('modal-video-debug--error');
        }

        function tick() {
            if (!videoStreamActive) return;
            var qrToggle = document.getElementById('videoStreamQrToggle');
            var withQr = qrToggle ? qrToggle.checked : false;
            var url = '/api/drone/frame-with-qr?t=' + Date.now() + (withQr ? '&fast=0' : '&fast=1');
            fetch(url)
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (data) {
                    if (!videoStreamActive) return;
                    if (data && data.debug) updateDebug(data.debug);
                    setTimeout(tick, 0);
                    if (!data || !data.image || !canvas) return;
                    var img = new Image();
                    img.onload = function () {
                        if (!videoStreamActive) return;
                        canvas.width = data.width;
                        canvas.height = data.height;
                        ctx.drawImage(img, 0, 0);
                        drawQrBoxes(data.qr || []);
                    };
                    img.onerror = function () { };
                    img.src = 'data:image/jpeg;base64,' + data.image;
                })
                .catch(function (err) {
                    if (videoStreamActive) {
                        var el = document.getElementById('videoStreamDebug');
                        if (el) { el.textContent = 'Ошибка запроса: ' + (err.message || err); el.classList.add('modal-video-debug--error'); }
                        setTimeout(tick, 50);
                    }
                });
        }
        tick();
    }

    function stopVideoStream() {
        videoStreamActive = false;
        var canvas = document.getElementById('videoStreamFrame');
        if (canvas) {
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    var nodeQrModalClose = document.getElementById('nodeQrModalClose');
    if (nodeQrModalClose) nodeQrModalClose.addEventListener('click', closeNodeQrModal);
    var nodeQrModal = document.getElementById('nodeQrModal');
    if (nodeQrModal) nodeQrModal.addEventListener('click', function (e) { if (e.target === nodeQrModal) closeNodeQrModal(); });

    var videoStreamBtn = document.getElementById('videoStreamBtn');
    var videoStreamModal = document.getElementById('videoStreamModal');
    var videoStreamModalClose = document.getElementById('videoStreamModalClose');
    if (videoStreamBtn && videoStreamModal) {
        videoStreamBtn.addEventListener('click', function () {
            videoStreamModal.classList.remove('hidden');
            startVideoStream();
        });
    }
    if (videoStreamModalClose && videoStreamModal) {
        videoStreamModalClose.addEventListener('click', function () {
            videoStreamModal.classList.add('hidden');
            stopVideoStream();
        });
    }
    if (videoStreamModal) {
        videoStreamModal.addEventListener('click', function (e) {
            if (e.target === videoStreamModal) {
                videoStreamModal.classList.add('hidden');
                stopVideoStream();
            }
        });
    }

    fetchNodeQrData();

    if (analyzeTopologyBtn) {
        analyzeTopologyBtn.addEventListener('click', function () {
            var file = currentImageFile || (fileInput && fileInput.files[0]);
            if (!file || !file.type.startsWith('image/')) {
                alert('Сначала загрузите изображение карты.');
                return;
            }
            analyzeTopologyBtn.disabled = true;
            analyzeTopologyBtn.textContent = 'Обработка…';

            var form = new FormData();
            form.append('image', file);

            fetch('/api/analyze-topology', {
                method: 'POST',
                body: form,
            })
                .then(function (res) {
                    if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || 'Ошибка'); });
                    return res.json();
                })
                .then(function (data) {
                    topologyData = data;
                    droneCell = null;
                    axisYDirection = null;
                    graphData = null;
                    flyoverRoute = null;
                    flyoverRouteLength = 0;
                    flyoverReturnStartIndex = null;
                    updateGraphButtons();
                    resizeOverlay();
                    drawOverlay();
                    fetch('/api/graph')
                        .then(function (res) { return res.ok ? res.json() : { nodes: [] }; })
                        .then(function (g) {
                            if (g.nodes && g.nodes.length) {
                                graphData = g;
                                fetchNodeQrData();
                                drawOverlay();
                            }
                        })
                        .catch(function () {});
                })
                .catch(function (err) {
                    alert('Ошибка: ' + (err.message || err));
                })
                .finally(function () {
                    analyzeTopologyBtn.disabled = false;
                    analyzeTopologyBtn.textContent = 'Распознать топологию';
                });
        });
    }

    var scaleInputs = ['buildingLength', 'buildingWidth', 'scaleX', 'scaleY'];
    scaleInputs.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', function () {
                graphData = null;
                flyoverRoute = null;
                flyoverRouteLength = 0;
                flyoverReturnStartIndex = null;
                updateRouteButtons();
                drawOverlay();
            });
        }
    });

    function getStorageSettings() {
        var type = 'cells';
        if (storageShelves && storageShelves.checked) type = 'shelves';
        var out = { storageType: type };
        if (type === 'shelves' && shelfLevelsCount && shelfLevelsList) {
            var n = Math.max(1, Math.min(20, parseInt(shelfLevelsCount.value, 10) || 2));
            var heights = [];
            var inputs = shelfLevelsList.querySelectorAll('.shelf-level-item input');
            for (var i = 0; i < inputs.length && i < n; i++) {
                heights.push(parseFloat(inputs[i].value) || (i + 1));
            }
            while (heights.length < n) heights.push(heights.length + 1);
            out.levelsCount = n;
            out.levelHeights = heights.slice(0, n);
        }
        return out;
    }

    function buildShelfLevelsList() {
        if (!shelfLevelsList || !shelfLevelsCount) return;
        var n = Math.max(1, Math.min(20, parseInt(shelfLevelsCount.value, 10) || 2));
        var prev = [];
        var items = shelfLevelsList.querySelectorAll('.shelf-level-item');
        for (var i = 0; i < items.length; i++) {
            var inp = items[i].querySelector('input');
            if (inp) prev.push(parseFloat(inp.value) || (i + 1));
        }
        shelfLevelsList.innerHTML = '';
        for (var k = 0; k < n; k++) {
            var val = prev[k] != null ? prev[k] : (k + 1);
            var item = document.createElement('div');
            item.className = 'shelf-level-item';
            var lab = document.createElement('label');
            lab.htmlFor = 'shelfLevelHeight_' + (k + 1);
            lab.textContent = 'Уровень ' + (k + 1) + ', высота (м):';
            var inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'input input-number';
            inp.id = 'shelfLevelHeight_' + (k + 1);
            inp.setAttribute('aria-label', 'Высота уровня ' + (k + 1));
            inp.min = '0.1';
            inp.step = '0.1';
            inp.value = val;
            item.appendChild(lab);
            item.appendChild(inp);
            shelfLevelsList.appendChild(item);
        }
    }

    if (storageCells) {
        storageCells.addEventListener('change', function () {
            if (this.checked) {
                if (storageShelves) storageShelves.checked = false;
                if (shelvesBlock) shelvesBlock.classList.add('hidden');
            } else {
                if (storageShelves) {
                    storageShelves.checked = true;
                    if (shelvesBlock) {
                        shelvesBlock.classList.remove('hidden');
                        buildShelfLevelsList();
                    }
                }
            }
        });
    }
    if (storageShelves) {
        storageShelves.addEventListener('change', function () {
            if (this.checked) {
                if (storageCells) storageCells.checked = false;
                if (shelvesBlock) {
                    shelvesBlock.classList.remove('hidden');
                    buildShelfLevelsList();
                }
            } else {
                if (storageCells) storageCells.checked = true;
                if (shelvesBlock) shelvesBlock.classList.add('hidden');
            }
        });
    }
    if (shelfLevelsCount) {
        shelfLevelsCount.addEventListener('input', buildShelfLevelsList);
        shelfLevelsCount.addEventListener('change', buildShelfLevelsList);
    }
    buildShelfLevelsList();

    if (buildGraphBtn) {
        buildGraphBtn.addEventListener('click', function () {
            if (!topologyData || !topologyData.walls || topologyData.walls.length < 4) {
                alert('Сначала распознайте топологию.');
                return;
            }
            buildGraph();
            flyoverRoute = null;
            flyoverRouteLength = 0;
            flyoverReturnStartIndex = null;
            updateRouteButtons();
            fetchNodeQrData();
            drawOverlay();
            fetch('/api/graph', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(graphData),
            })
                .then(function (res) {
                    if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || 'Ошибка'); });
                    return res.json();
                })
                .then(function () {
                    if (buildGraphBtn) buildGraphBtn.textContent = 'Граф сохранён';
                    setTimeout(function () {
                        if (buildGraphBtn) buildGraphBtn.textContent = 'Построить граф';
                    }, 1500);
                })
                .catch(function (err) {
                    alert('Ошибка сохранения графа: ' + (err.message || err));
                });
        });
    }

    if (loadGraphBtn) {
        loadGraphBtn.addEventListener('click', function () {
            fetch('/api/graph')
                .then(function (res) {
                    if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || 'Ошибка'); });
                    return res.json();
                })
                .then(function (data) {
                    if (data.nodes && data.nodes.length) {
                        graphData = data;
                        flyoverRoute = null;
                        flyoverRouteLength = 0;
                        flyoverReturnStartIndex = null;
                        updateRouteButtons();
                        fetchNodeQrData();
                        drawOverlay();
                    } else {
                        graphData = null;
                        drawOverlay();
                        alert('Сохранённый граф пуст. Постройте граф и сохраните его.');
                    }
                })
                .catch(function (err) {
                    alert('Ошибка загрузки графа: ' + (err.message || err));
                });
        });
    }

    if (buildRouteBtn) {
        buildRouteBtn.addEventListener('click', function () {
            if (!graphData || !graphData.nodes || !graphData.nodes.length) {
                alert('Сначала постройте граф.');
                return;
            }
            buildFlyoverRoute();
            updateRouteStats();
            updateRouteButtons();
        });
    }

    if (startSimulationBtn) {
        startSimulationBtn.addEventListener('click', function () {
            if (!flyoverRoute || !flyoverRoute.length || !graphData || !graphData.nodes) return;
            if (simulationInterval) return;
            var nodeMap = {};
            for (var n = 0; n < graphData.nodes.length; n++) {
                var u = graphData.nodes[n];
                nodeMap[u.id] = u;
            }
            var idx = 0;
            if (stopSimulationBtn) stopSimulationBtn.disabled = false;
            if (startSimulationBtn) startSimulationBtn.disabled = true;
            simulationInterval = setInterval(function () {
                var nodeId_ = flyoverRoute[idx];
                var node = nodeMap[nodeId_];
                if (node) {
                    droneCell = { i: node.i, j: node.j };
                    drawOverlay();
                }
                idx++;
                if (idx >= flyoverRoute.length) {
                    clearInterval(simulationInterval);
                    simulationInterval = null;
                    if (stopSimulationBtn) stopSimulationBtn.disabled = true;
                    if (startSimulationBtn) startSimulationBtn.disabled = false;
                }
            }, 400);
        });
    }

    if (stopSimulationBtn) {
        stopSimulationBtn.addEventListener('click', function () {
            if (simulationInterval) {
                clearInterval(simulationInterval);
                simulationInterval = null;
            }
            stopSimulationBtn.disabled = true;
            if (flyoverRoute && flyoverRoute.length) startSimulationBtn.disabled = false;
        });
    }

    if (startDroneBtn) {
        startDroneBtn.addEventListener('click', function () {
            if (!flyoverRoute || !flyoverRoute.length || !graphData || !graphData.nodes || !graphData.meta) {
                alert('Сначала постройте маршрут.');
                return;
            }
            var nodeMap = {};
            for (var n = 0; n < graphData.nodes.length; n++) {
                var u = graphData.nodes[n];
                nodeMap[u.id] = u;
            }
            var route = [];
            for (var r = 0; r < flyoverRoute.length; r++) {
                var nd = nodeMap[flyoverRoute[r]];
                if (nd) route.push({ id: nd.id, i: nd.i, j: nd.j });
            }
            var meta = graphData.meta || { scaleX: 1, scaleY: 1 };
            var heightEl = document.getElementById('flightHeight');
            var height = heightEl ? parseFloat(heightEl.value) : 1.5;
            if (isNaN(height) || height < 0.5) height = 1.5;
            if (height > 10) height = 10;
            var payload = { route: route, meta: meta, height: height };
            if (axisYDirection && (axisYDirection.di !== 0 || axisYDirection.dj !== 0)) {
                payload.axisY = { di: axisYDirection.di, dj: axisYDirection.dj };
            }
            if (flyoverReturnStartIndex != null) {
                payload.return_start_index = flyoverReturnStartIndex;
            }
            startDroneBtn.disabled = true;
            fetch('/api/drone/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.ok) {
                        startDroneBtn.textContent = 'Дрон летит…';
                    } else {
                        alert(data.error || 'Ошибка запуска');
                        startDroneBtn.disabled = false;
                    }
                })
                .catch(function (err) {
                    alert('Ошибка: ' + (err.message || err));
                    startDroneBtn.disabled = false;
                });
        });
    }

    if (landDroneBtn) {
        landDroneBtn.addEventListener('click', function () {
            fetch('/api/drone/land', { method: 'POST' })
                .then(function (res) { return res.json(); })
                .then(function () {
                    resetDroneButton();
                })
                .catch(function (err) {
                    alert('Ошибка посадки: ' + (err.message || err));
                });
        });
    }

    function resetDroneButton() {
        if (startDroneBtn) {
            startDroneBtn.textContent = 'Запустить дрон';
            startDroneBtn.disabled = !(flyoverRoute && flyoverRoute.length);
        }
    }

    var wasMissionActive = false;
    setInterval(function () {
        fetch('/api/drone/status')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (wasMissionActive && !data.mission_active) {
                    wasMissionActive = false;
                    resetDroneButton();
                    fetchNodeQrData();
                } else if (data.mission_active) {
                    wasMissionActive = true;
                }
                if (data.mission_active && flyoverRoute && graphData && graphData.nodes) {
                    var nodeIdx = data.current_waypoint_index >= 0 ? data.current_waypoint_index : data.current_node_index;
                    if (nodeIdx >= 0 && nodeIdx < flyoverRoute.length) {
                        var nodeMap = {};
                        for (var n = 0; n < graphData.nodes.length; n++) {
                            var u = graphData.nodes[n];
                            nodeMap[u.id] = u;
                        }
                        var nodeId_ = flyoverRoute[nodeIdx];
                        var node = nodeMap[nodeId_];
                        if (node) {
                            droneCell = { i: node.i, j: node.j };
                            drawOverlay();
                        }
                    }
                }
            })
            .catch(function () {});
    }, 200);

    if (mapWrapper && typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function () { resizeOverlay(); });
        ro.observe(mapWrapper);
    }
    window.addEventListener('resize', function () { resizeOverlay(); });

    if (browseBtn && fileInput) {
        browseBtn.addEventListener('click', function () { fileInput.click(); });
    }

    if (fileInput && fileDisplay) {
        fileInput.addEventListener('change', function () {
            var file = this.files[0];
            fileDisplay.value = file ? file.name : '';
            if (file && file.type.startsWith('image/')) showPreview(file);
        });
    }

    if (uploadFileBtn) {
        uploadFileBtn.addEventListener('click', function () {
            if (!fileInput || !fileInput.files.length) {
                alert('Сначала выберите файл карты.');
                return;
            }
            var file = fileInput.files[0];
            if (file.type.startsWith('image/')) showPreview(file);
            alert('Файл «' + file.name + '» принят. Загрузка на сервер будет в следующей версии.');
        });
    }

    if (uploadZone && imageInput) {
        uploadZone.addEventListener('click', function () { imageInput.click(); });
        uploadZone.addEventListener('dragover', function (e) {
            e.preventDefault();
            uploadZone.classList.add('drag-over');
        });
        uploadZone.addEventListener('dragleave', function () {
            uploadZone.classList.remove('drag-over');
        });
        uploadZone.addEventListener('drop', function (e) {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            var file = e.dataTransfer.files[0];
            if (file) showPreview(file);
        });
    }

    if (imageInput) {
        imageInput.addEventListener('change', function () {
            var file = this.files[0];
            if (file) showPreview(file);
        });
    }
})();
