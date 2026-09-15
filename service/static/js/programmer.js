/* Visual move/lift workflow adapted from Hello-pioner for the WDR graph protocol. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let graph = {nodes: [], edges: []}, actions = [], start = null, target = null;
    let mode = 'target', plan = null, run = null, programs = [], busy = false;
    const status = (text, error = false) => {
        $('programStatus').textContent = text;
        $('programStatus').classList.toggle('is-error', error);
    };
    async function api(path, data, method) {
        const response = await fetch(path, {method: method || (data === undefined ? 'GET' : 'POST'),
            headers: data === undefined ? {} : {'Content-Type': 'application/json'},
            body: data === undefined ? undefined : JSON.stringify(data)});
        const result = await response.json();
        if (!response.ok || result.ok === false) {
            if (result.run) { run = result.run; renderRun(); }
            throw new Error(result.error || result.run?.error || 'Ошибка запроса');
        }
        return result;
    }
    const payload = () => ({name: $('programName').value.trim(), start_node: start,
        start_heading: Number($('startHeading').value), actions});
    function bind(id, fn) {
        $(id).addEventListener('click', async () => {
            if (busy && id !== 'stopRobot') return;
            const button = $(id);
            button.disabled = true;
            if (id !== 'stopRobot') busy = true;
            try { await fn(); } catch (error) { status(error.message, true); }
            finally { if (id !== 'stopRobot') busy = false; button.disabled = false; renderRun(); }
        });
    }
    function invalidate() { plan = null; renderGraph(); renderPlan(); }
    function commandText(command) {
        if (command.type === 'turn') return `Поворот ${command.angle}°`;
        if (command.type === 'drive') return `Проехать ${command.distance} м до узла ${command.target_node}`;
        return command.action === 'up' ? 'Поднять груз' : 'Опустить груз';
    }
    function makeButton(text, handler, label) {
        const button = document.createElement('button');
        button.className = 'text-button'; button.type = 'button'; button.textContent = text;
        if (label) button.setAttribute('aria-label', label);
        button.addEventListener('click', handler); return button;
    }
    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('ui-icon'); svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(svg.namespaceURI, 'use');
        use.setAttribute('href', '/static/images/icons.svg#' + name); svg.append(use);
        return svg;
    }
    function iconButton(name, handler, label) {
        const button = makeButton('', handler, label);
        button.classList.add('action-control'); button.title = label; button.append(icon(name));
        return button;
    }
    function renderActions() {
        $('actionCount').textContent = `${actions.length} действий`;
        $('actionList').replaceChildren();
        actions.forEach((action, index) => {
            const row = document.createElement('li'); row.className = 'action-row';
            const order = document.createElement('span'); order.className = 'action-order';
            order.textContent = String(index + 1).padStart(2, '0');
            const label = document.createElement('div'); label.className = 'action-description';
            const title = document.createElement('strong');
            title.textContent = action.type === 'move' ? 'Перемещение' : action.lift_action === 'up' ? 'Поднять груз' : 'Опустить груз';
            const detail = document.createElement('span');
            if (action.type === 'move') {
                detail.textContent = 'Узел ' + action.target_node;
            } else detail.textContent = 'Управление подъёмником';
            label.append(title, detail); row.append(order, label);
            const controls = document.createElement('span'); controls.className = 'row-controls';
            const reorder = offset => {
                const next = index + offset;
                if (next < 0 || next >= actions.length) return;
                [actions[next], actions[index]] = [actions[index], actions[next]];
                renderActions(); invalidate(); renderRun();
            };
            const up = iconButton('arrow-up', () => reorder(-1), 'Переместить действие выше');
            const down = iconButton('arrow-down', () => reorder(1), 'Переместить действие ниже');
            up.dataset.reorder = 'up'; down.dataset.reorder = 'down';
            up.disabled = index === 0; down.disabled = index === actions.length - 1;
            controls.append(up, down, iconButton('trash', () => { actions.splice(index, 1); renderActions(); invalidate(); renderRun(); }, 'Удалить действие'));
            row.append(controls); $('actionList').append(row);
        });
        if (!actions.length) {
            const empty = document.createElement('li'); empty.className = 'empty-state';
            empty.textContent = 'Добавьте перемещение или действие с грузом.'; $('actionList').append(empty);
        }
    }
    function renderGraph() {
        const svg = $('programGraph'); svg.replaceChildren();
        $('graphSummary').textContent = `${graph.nodes.length} узлов · ${graph.edges.length} рёбер`;
        $('selectionSummary').textContent = `Старт: ${start || '—'} · Цель: ${target || '—'}`;
        const ns = 'http://www.w3.org/2000/svg';
        const el = (tag, attrs) => { const node = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); return node; };
        if (!graph.nodes.length) {
            const text = el('text', {x: 380, y: 210, 'text-anchor': 'middle'});
            text.textContent = 'Создайте граф на странице «Карта и дрон»'; svg.append(text); return;
        }
        const xs = graph.nodes.map(n => n.i), ys = graph.nodes.map(n => n.j);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const scale = Math.min(620 / Math.max(1, Math.max(...xs) - minX), 310 / Math.max(1, Math.max(...ys) - minY));
        const width = (Math.max(...xs) - minX) * scale, height = (Math.max(...ys) - minY) * scale;
        const positions = Object.fromEntries(graph.nodes.map(n => [n.id, {x: (760 - width) / 2 + (n.i - minX) * scale, y: (430 + height) / 2 - (n.j - minY) * scale}]));
        const routeEdges = new Set();
        if (plan) for (let i = 1; i < plan.route.length; i++) {
            routeEdges.add(JSON.stringify([plan.route[i - 1], plan.route[i]]));
            routeEdges.add(JSON.stringify([plan.route[i], plan.route[i - 1]]));
        }
        graph.edges.forEach(edge => {
            const a = positions[edge.from], b = positions[edge.to]; if (!a || !b) return;
            svg.append(el('line', {x1:a.x, y1:a.y, x2:b.x, y2:b.y,
                class: routeEdges.has(JSON.stringify([edge.from, edge.to])) ? 'graph-edge route-edge' : 'graph-edge'}));
        });
        graph.nodes.forEach(node => {
            const p = positions[node.id];
            const group = el('g', {tabindex:0, role:'button', 'aria-label':`Узел ${node.id}`, class:'graph-node'});
            group.append(el('circle', {cx:p.x, cy:p.y, r:Math.max(5, Math.min(15, scale * 0.2)),
                class:node.id === start ? 'node-start' : node.id === target ? 'node-target' : ''}));
            if (graph.nodes.length <= 100) {
                const text = el('text', {x:p.x, y:p.y + 30, 'text-anchor':'middle'}); text.textContent = node.id; group.append(text);
            }
            const select = () => { if (run && !['completed','stopped'].includes(run.status)) return; if (mode === 'start') start = node.id; else target = node.id; invalidate(); };
            group.addEventListener('click', select);
            group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
            svg.append(group);
        });
    }
    function renderPlan() {
        $('planSummary').textContent = plan ? `${plan.distance_m} м · ${plan.route.length} посещений узлов · ${plan.commands.length} команд. Маршрут проверен.` : 'Предварительный расчёт покажет длину пути и команды робота.';
        $('commandList').replaceChildren();
        for (const command of plan?.commands || []) { const li = document.createElement('li'); li.textContent = commandText(command); $('commandList').append(li); }
    }
    async function refreshPrograms() {
        programs = (await api('/api/robot/programs')).programs;
        $('savedPrograms').replaceChildren();
        if (!programs.length) $('savedPrograms').textContent = 'Пока нет сохранённых программ.';
        programs.forEach(program => {
            const row = document.createElement('article'); row.className = 'saved-program';
            const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = program.name;
            const meta = document.createElement('p'); meta.className = 'form-hint'; meta.textContent = `${program.actions.length} действий · Старт ${program.start_node}`;
            text.append(name, meta); row.append(text);
            row.append(makeButton('Загрузить', () => {
                actions = program.actions.map(a => ({...a})); start = program.start_node; target = null;
                $('programName').value = program.name; $('startHeading').value = program.start_heading ?? 90;
                renderActions(); invalidate(); status('Программа загружена. Проверьте маршрут по текущей карте.');
            }));
            row.append(makeButton('Удалить', async () => {
                if (!window.confirm(`Удалить программу «${program.name}»?`)) return;
                try { await api(`/api/robot/programs/${encodeURIComponent(program.id)}`, undefined, 'DELETE'); await refreshPrograms(); }
                catch (error) { status(error.message, true); }
            }));
            $('savedPrograms').append(row);
        });
    }
    function renderRun() {
        const active = run && !['completed','stopped'].includes(run.status);
        document.querySelectorAll('#selectStart, #selectTarget, #programName, #startHeading, #addMove, #addLiftUp, #addLiftDown, #previewProgram, #clearProgram, #saveProgram, #actionList button, #savedPrograms button').forEach(button => {
            button.disabled = Boolean(active);
        });
        const rows = $('actionList').querySelectorAll('.action-row');
        rows.forEach((row, index) => {
            row.querySelector('[data-reorder="up"]').disabled = Boolean(active) || index === 0;
            row.querySelector('[data-reorder="down"]').disabled = Boolean(active) || index === rows.length - 1;
        });
        $('programGraph').style.pointerEvents = active ? 'none' : '';
        $('programGraph').querySelectorAll('[role="button"]').forEach(node => node.setAttribute('tabindex', active ? '-1' : '0'));
        $('startProgram').disabled = busy || Boolean(active);
        $('nextStep').disabled = busy || !run || !['ready','waiting'].includes(run.status) || !$('confirmStep').checked;
        $('robotAddress').disabled = Boolean(active);
        if (!run) return;
        const next = run.plan.commands[run.next_index];
        const labels = {ready:'Готов к первой команде', waiting:'Ожидается подтверждение оператора', completed:'Завершение подтверждено оператором', stopped:'STOP передан', error:'Ошибка связи: положение неизвестно', stop_failed:'Не удалось передать STOP'};
        $('runStatus').textContent = `${labels[run.status]} · Передано ${run.next_index}/${run.plan.commands.length}. ${active && next ? 'Следующая: ' + commandText(next) : ''} ${run.error || ''}`;
        $('nextStep').querySelector('span').textContent = next ? 'Отправить следующую команду' : 'Подтвердить завершение';
    }
    bind('selectStart', () => { mode = 'start'; $('mapHint').textContent = 'Нажмите на узел, в котором сейчас находится робот.'; });
    bind('selectTarget', () => { mode = 'target'; $('mapHint').textContent = 'Нажмите на целевой узел, затем добавьте перемещение.'; });
    bind('addMove', () => { if (!target) throw new Error('Сначала выберите цель на графе'); actions.push({type:'move', target_node:target}); renderActions(); invalidate(); });
    for (const [id, lift] of [['addLiftUp','up'], ['addLiftDown','down']]) bind(id, () => { actions.push({type:'lift', lift_action:lift}); renderActions(); invalidate(); });
    bind('clearProgram', () => { actions = []; start = null; target = null; renderActions(); invalidate(); });
    bind('previewProgram', async () => { plan = (await api('/api/robot/programs/preview', payload())).plan; renderGraph(); renderPlan(); status('Маршрут проверен. Робот не получал команд.'); });
    bind('saveProgram', async () => { await api('/api/robot/programs', payload()); await refreshPrograms(); status('Программа сохранена.'); });
    bind('refreshPrograms', refreshPrograms);
    bind('startProgram', async () => {
        run = (await api('/api/robot/execute-current-program', {...payload(), dry_run:false, base_url:$('robotAddress').value})).run;
        plan = run.plan; renderGraph(); renderPlan();
        $('confirmStep').checked = false; status('Запуск подготовлен. Подтвердите положение робота, чтобы отправить первую команду.');
    });
    bind('nextStep', async () => {
        try { run = (await api('/api/robot/program-run/step', {run_id:run.id, expected_index:run.next_index, confirm_completed:$('confirmStep').checked})).run; }
        finally { $('confirmStep').checked = false; }
    });
    bind('stopRobot', async () => { const result = await api('/api/robot/stop', {base_url:$('robotAddress').value}); run = result.run; $('confirmStep').checked = false; status(result.message); });
    $('startHeading').addEventListener('change', invalidate);
    $('confirmStep').addEventListener('change', renderRun);
    async function init() {
        renderActions();
        try {
            graph = await api('/api/graph'); renderGraph();
            await refreshPrograms(); run = (await api('/api/robot/program-run')).run;
            if (run) {
                $('robotAddress').value = run.base_url;
                if (!['completed','stopped'].includes(run.status)) {
                    start = run.plan.start_node; actions = run.plan.actions.map(action => ({...action}));
                    $('startHeading').value = run.plan.start_heading;
                    $('programName').value = 'Текущая сессия'; plan = run.plan;
                    renderActions(); renderGraph(); renderPlan();
                }
            }
            renderRun(); status(graph.nodes.length ? 'Карта загружена. Выберите стартовую и целевую точки.' : 'Сначала создайте и сохраните граф на странице «Карта и дрон».');
        } catch (error) { status(error.message, true); }
    }
    init();
})();
