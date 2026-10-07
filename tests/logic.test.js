import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  filterAndSearchTasks,
  computeDueStatus,
  calculateStatistics,
  generateDailyAgendaTemplate,
  validateAndImportData
} from '../src/logic.js';

test('createTask should create a valid task in todo column', () => {
  const now = Date.now();
  const tasks = [];
  const taskData = { title: 'Test Görevi', description: 'Açıklama', priority: 'high', tags: ['İş'] };
  const updated = createTask(tasks, taskData, now);

  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, 'Test Görevi');
  assert.equal(updated[0].columnId, 'todo');
  assert.equal(updated[0].priority, 'high');
  assert.equal(updated[0].order, 0);
});

test('createTask should throw error on empty title', () => {
  assert.throws(() => {
    createTask([], { title: '   ' }, Date.now());
  }, /Görev başlığı boş olamaz/);
});

test('updateTask should update completedAt when moved to done', () => {
  const now = Date.now();
  const tasks = [{
    id: 't1', title: 'Task 1', description: '', columnId: 'todo', priority: 'low', tags: [], dueDate: null, createdAt: new Date(now).toISOString(), completedAt: null, order: 0
  }];

  const updated = updateTask(tasks, 't1', { columnId: 'done' }, now);
  assert.equal(updated[0].columnId, 'done');
  assert.notEqual(updated[0].completedAt, null);
});

test('updateTask should clear completedAt when moved out of done', () => {
  const now = Date.now();
  const tasks = [{
    id: 't1', title: 'Task 1', description: '', columnId: 'done', priority: 'low', tags: [], dueDate: null, createdAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), order: 0
  }];

  const updated = updateTask(tasks, 't1', { columnId: 'in_progress' }, now);
  assert.equal(updated[0].columnId, 'in_progress');
  assert.equal(updated[0].completedAt, null);
});

test('moveTask should correctly reindex orders', () => {
  const now = Date.now();
  const tasks = [
    { id: 't1', title: 'T1', columnId: 'todo', order: 0 },
    { id: 't2', title: 'T2', columnId: 'todo', order: 1 },
    { id: 't3', title: 'T3', columnId: 'todo', order: 2 }
  ];

  const moved = moveTask(tasks, 't1', 'todo', 2, now);
  const todoTasks = moved.filter(t => t.columnId === 'todo').sort((a, b) => a.order - b.order);

  assert.equal(todoTasks[0].id, 't2');
  assert.equal(todoTasks[1].id, 't3');
  assert.equal(todoTasks[2].id, 't1');
  assert.equal(todoTasks[2].order, 2);
});

test('computeDueStatus should return overdue for past due dates on incomplete tasks', () => {
  const now = Date.now();
  const pastDate = new Date(now - 10000).toISOString();
  assert.equal(computeDueStatus(pastDate, false, now), 'overdue');
  assert.equal(computeDueStatus(pastDate, true, now), 'no_due');
});

test('computeDueStatus should return due_soon within 24 hours', () => {
  const now = Date.now();
  const soonDate = new Date(now + 3600000).toISOString();
  assert.equal(computeDueStatus(soonDate, false, now), 'due_soon');
});

test('filterAndSearchTasks should filter correctly with Turkish characters', () => {
  const tasks = [
    { id: '1', title: 'Rapor Hazırla', description: 'Yıllık bütçe', tags: ['Finans'], columnId: 'todo', priority: 'high', dueDate: null },
    { id: '2', title: 'Toplantı yap', description: 'Şirket genel', tags: ['Genel'], columnId: 'todo', priority: 'low', dueDate: null }
  ];

  const result = filterAndSearchTasks(tasks, 'rapor', 'high', 'Finans', false, Date.now());
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '1');
});

test('calculateStatistics should compute stats accurately', () => {
  const now = Date.now();
  const isoNow = new Date(now).toISOString();
  const tasks = [
    { id: '1', columnId: 'done', completedAt: isoNow, dueDate: null },
    { id: '2', columnId: 'todo', dueDate: new Date(now - 100000).toISOString() }, // overdue
    { id: '3', columnId: 'in_progress', dueDate: null }
  ];

  const stats = calculateStatistics(tasks, now);
  assert.equal(stats.completedToday, 1);
  assert.equal(stats.overdueCount, 1);
  assert.equal(stats.totalTasks, 3);
  assert.equal(stats.completionRate, 33);
});

test('generateDailyAgendaTemplate should produce at least three valid tasks', () => {
  const agenda = generateDailyAgendaTemplate(Date.now());
  assert.ok(Array.isArray(agenda));
  assert.ok(agenda.length >= 3);
  assert.equal(agenda[0].columnId, 'todo');
});

test('validateAndImportData should reject malformed JSON or invalid columns', () => {
  const badJson = JSON.stringify({ tasks: [{ id: '1', title: 'Test', columnId: 'invalid_col' }] });
  const res = validateAndImportData(badJson);
  assert.equal(res.success, false);
  assert.notEqual(res.error, null);
});
