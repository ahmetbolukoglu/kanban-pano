import { createTask, updateTask, deleteTask, moveTask, filterAndSearchTasks, computeDueStatus, calculateStatistics, generateDailyAgendaTemplate, validateAndImportData } from './logic.js';

const STORAGE_KEY = 'kanban-pano:v1';
const DEFAULT_STATE = {
    tasks: [],
    settings: { soundEnabled: true },
    tags: ['İş', 'Kişisel', 'Önemli', 'Proje']
};

let state = loadState();
let currentDraggingId = null;
let currentTags = [];

const $ = id => document.getElementById(id);

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_STATE;
        const parsed = JSON.parse(raw);
        return {
            tasks: Array.isArray(parsed.tasks) ? parsed.tasks : DEFAULT_STATE.tasks,
            settings: { soundEnabled: parsed.settings?.soundEnabled ?? true },
            tags: Array.isArray(parsed.tags) ? parsed.tags : DEFAULT_STATE.tags
        };
    } catch {
        return DEFAULT_STATE;
    }
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.error('Save failed', e);
    }
}

function playBeep(success = true) {
    if (!state.settings.soundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(success ? 587.33 : 220, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch {}
}

function announce(msg) {
    const el = $('sr-announcement');
    if (el) el.textContent = msg;
}

function init() {
    bindEvents();
    render();
}

function bindEvents() {
    const searchInput = $('search-input');
    if (searchInput) searchInput.addEventListener('input', render);

    const loadTemplateBtn = $('load-template-btn');
    if (loadTemplateBtn) {
        loadTemplateBtn.addEventListener('click', () => {
            const templateTasks = generateDailyAgendaTemplate(new Date().toISOString());
            let tList = [...state.tasks];
            templateTasks.forEach(item => {
                tList = createTask(tList, item, new Date().toISOString());
            });
            state.tasks = tList;
            saveState();
            render();
            playBeep(true);
            announce('Günlük gündem şablonu yüklendi.');
        });
    }

    const exportBtn = $('export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const area = $('export-json-area');
            if (area) area.value = JSON.stringify(state, null, 2);
            $('export-modal').classList.remove('hidden');
        });
    }

    ['export-modal-close-btn', 'export-close-action'].forEach(id => {
        const btn = $(id);
        if (btn) btn.addEventListener('click', () => $('export-modal').classList.add('hidden'));
    });

    const copyJsonBtn = $('copy-json-btn');
    if (copyJsonBtn) {
        copyJsonBtn.addEventListener('click', () => {
            const area = $('export-json-area');
            if (area) {
                navigator.clipboard.writeText(area.value);
                alert('Pano verisi panoya kopyalandı.');
            }
        });
    }

    const downloadJsonBtn = $('download-json-btn');
    if (downloadJsonBtn) {
        downloadJsonBtn.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kanban-pano-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const importInput = $('import-file-input');
    if (importInput) {
        importInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = evt => {
                const res = validateAndImportData(evt.target.result);
                const errEl = $('import-error-msg');
                if (res.success) {
                    state = res.data;
                    saveState();
                    render();
                    $('export-modal').classList.add('hidden');
                    alert('Veriler başarıyla içe aktarıldı.');
                } else {
                    if (errEl) {
                        errEl.textContent = res.error || 'Geçersiz veri biçimi.';
                        errEl.classList.remove('hidden');
                    }
                }
            };
            reader.readAsText(file);
        });
    }

    document.querySelectorAll('.col-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const colId = btn.dataset.column;
            openTaskModal(null, colId);
        });
    });

    const taskForm = $('task-form');
    if (taskForm) {
        taskForm.addEventListener('submit', e => {
            e.preventDefault();
            const id = $('task-id').value;
            const title = $('task-title').value.trim();
            const description = $('task-desc').value.trim();
            const columnId = $('task-column').value;
            const priority = $('task-priority').value;
            const dueVal = $('task-due-date').value;
            const dueDate = dueVal ? new Date(dueVal).toISOString() : null;
            const now = new Date().toISOString();

            if (!title) return;

            if (id) {
                state.tasks = updateTask(state.tasks, id, { title, description, columnId, priority, dueDate, tags: currentTags }, now);
                announce('Görev güncellendi');
            } else {
                state.tasks = createTask(state.tasks, { title, description, columnId, priority, dueDate, tags: currentTags }, now);
                announce('Yeni görev oluşturuldu');
            }

            saveState();
            closeTaskModal();
            render();
            playBeep(true);
        });
    }

    const addTagBtn = $('add-tag-btn');
    const tagInput = $('task-tag-input');
    if (addTagBtn && tagInput) {
        const addTag = () => {
            const val = tagInput.value.trim();
            if (val && !currentTags.includes(val)) {
                currentTags.push(val);
                renderTagsChips();
                tagInput.value = '';
            }
        };
        addTagBtn.addEventListener('click', addTag);
        tagInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
            }
        });
    }

    ['modal-close-btn', 'modal-cancel-btn'].forEach(id => {
        const btn = $(id);
        if (btn) btn.addEventListener('click', closeTaskModal);
    });

    ['todo', 'in_progress', 'done'].forEach(colId => {
        const list = $(`${colId}-list`);
        if (!list) return;

        list.addEventListener('click', e => {
            const card = e.target.closest('.task-card');
            if (!card) return;
            const taskId = card.dataset.id;

            if (e.target.closest('.task-delete-btn')) {
                if (confirm('Bu görevi silmek istediğinize emin misiniz?')) {
                    state.tasks = deleteTask(state.tasks, taskId);
                    saveState();
                    render();
                    announce('Görev silindi');
                }
                return;
            }

            if (e.target.closest('.task-edit-btn') || !e.target.closest('button')) {
                openTaskModal(taskId);
            }
        });

        list.addEventListener('dragover', e => e.preventDefault());
        list.addEventListener('drop', e => {
            e.preventDefault();
            if (!currentDraggingId) return;
            const now = new Date().toISOString();
            state.tasks = moveTask(state.tasks, currentDraggingId, colId, 0, now);
            currentDraggingId = null;
            saveState();
            render();
            playBeep(true);
        });
    });
}

function openTaskModal(taskId = null, defaultCol = 'todo') {
    const modal = $('task-modal');
    if (!modal) return;
    $('task-id').value = '';
    $('task-title').value = '';
    $('task-desc').value = '';
    $('task-column').value = defaultCol;
    $('task-priority').value = 'medium';
    $('task-due-date').value = '';
    currentTags = [];

    if (taskId) {
        const task = state.tasks.find(t => t.id === taskId);
        if (task) {
            $('task-id').value = task.id;
            $('task-title').value = task.title;
            $('task-desc').value = task.description || '';
            $('task-column').value = task.columnId;
            $('task-priority').value = task.priority;
            if (task.dueDate) {
                $('task-due-date').value = task.dueDate.slice(0, 16);
            }
            currentTags = [...(task.tags || [])];
        }
    }
    renderTagsChips();
    modal.classList.remove('hidden');
    $('task-title').focus();
}

function closeTaskModal() {
    const modal = $('task-modal');
    if (modal) modal.classList.add('hidden');
}

function renderTagsChips() {
    const container = $('selected-tags-list');
    if (!container) return;
    container.innerHTML = currentTags.map(tag => `
        <span class="tag-chip">#${tag} <button type="button" data-tag="${tag}" class="tag-remove">&times;</button></span>
    `).join('');

    container.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            currentTags = currentTags.filter(t => t !== btn.dataset.tag);
            renderTagsChips();
        });
    });
}

function render() {
    const searchInput = $('search-input');
    const query = searchInput ? searchInput.value : '';
    const now = new Date().toISOString();
    const filtered = filterAndSearchTasks(state.tasks, query, 'all', 'all', false, now);

    const cols = { todo: [], in_progress: [], done: [] };
    filtered.forEach(t => {
        if (cols[t.columnId]) cols[t.columnId].push(t);
    });

    Object.keys(cols).forEach(colId => {
        const listEl = $(`${colId}-list`);
        const countEl = $(`${colId}-count`);
        if (countEl) countEl.textContent = cols[colId].length;

        if (listEl) {
            listEl.innerHTML = cols[colId].map(task => {
                const dueStatus = computeDueStatus(task.dueDate, task.columnId === 'done', now);
                let dueBadge = '';
                if (dueStatus === 'overdue') dueBadge = `<span class="badge badge-overdue">Gecikti</span>`;
                else if (dueStatus === 'due_soon') dueBadge = `<span class="badge badge-soon">Yaklaşıyor</span>`;

                const priorityLabels = { low: 'Düşük', medium: 'Orta', high: 'Yüksek', urgent: 'Acil' };
                const tagsHtml = (task.tags || []).map(tag => `<span class="task-tag">#${tag}</span>`).join('');

                return `
                    <div class="task-card priority-${task.priority}" draggable="true" data-id="${task.id}">
                        <div class="task-card-header">
                            <span class="priority-badge ${task.priority}">${priorityLabels[task.priority]}</span>
                            <div class="task-actions">
                                <button class="btn-icon task-edit-btn" title="Düzenle">✏️</button>
                                <button class="btn-icon task-delete-btn" title="Sil">🗑️</button>
                            </div>
                        </div>
                        <h4 class="task-card-title">${escapeHTML(task.title)}</h4>
                        ${task.description ? `<p class="task-card-desc">${escapeHTML(task.description)}</p>` : ''}
                        <div class="task-card-footer">
                            <div class="task-meta">
                                ${tagsHtml}
                                ${dueBadge}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            listEl.querySelectorAll('.task-card').forEach(card => {
                card.addEventListener('dragstart', () => {
                    currentDraggingId = card.dataset.id;
                    card.classList.add('dragging');
                });
                card.addEventListener('dragend', () => {
                    card.classList.remove('dragging');
                    currentDraggingId = null;
                });
            });
        }
    });

    const stats = calculateStatistics(state.tasks, now);
    const statsSummary = $('stats-summary');
    if (statsSummary) {
        statsSummary.innerHTML = `
            <span>Bugün: <strong>${stats.todayCompleted}</strong></span>
            <span>Son 7 Gün: <strong>${stats.weekCompleted}</strong></span>
            <span>Tamamlanma: <strong>%${stats.completionRate}</strong></span>
        `;
    }
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

document.addEventListener('DOMContentLoaded', init);
