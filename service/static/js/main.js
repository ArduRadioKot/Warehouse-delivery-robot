(function () {
    'use strict';

    const searchInput = document.getElementById('searchInput');
    const robotsGrid = document.getElementById('robotsGrid');
    const createTaskBtn = document.getElementById('createTaskBtn');
    const cards = document.querySelectorAll('.card');

    if (searchInput && robotsGrid) {
        searchInput.addEventListener('input', function () {
            const query = this.value.trim().toLowerCase();
            cards.forEach(function (card) {
                const name = (card.getAttribute('data-name') || '').toLowerCase();
                const status = (card.getAttribute('data-status') || '').toLowerCase();
                const match = !query || name.includes(query) || status.includes(query);
                card.classList.toggle('hidden', !match);
            });
        });
    }

    if (createTaskBtn) {
        createTaskBtn.addEventListener('click', function () {
            window.location.href = '/new-task';
        });
    }

    robotsGrid && robotsGrid.addEventListener('click', function (e) {
        const btn = e.target.closest('.btn-card');
        if (!btn) return;
        const robotId = btn.getAttribute('data-robot-id');
        if (robotId) {
            alert('Открытие робота #' + robotId);
            // window.location.href = '/robot/' + robotId;
        }
    });
})();
