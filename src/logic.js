export function createTask(tasks, taskData, currentTime) {
  if (!taskData || typeof taskData.title !== 'string' || !taskData.title.trim()) {
    throw new Error('Görev başlığı boş olamaz.');
  }
  const columnId = taskData.columnId || 'todo';
  if (!['todo', 'in_progress', 'done'].includes(columnId)) {
    throw new Error('Geçersiz sütun ID.');
  }

  const columnTasks = tasks.filter(t => t.columnId === columnId);
  const maxOrder = columnTasks.length > 0 ? Math.max(...columnTasks.map(t => t.order)) : -1;

  const newTask = {
    id: taskData.id || `task_${currentTime}_${Math.random().toString(36).substring(2, 7)}`,
    title: taskData.title.trim(),
    description: taskData.description ? taskData.description.trim() : '',
    columnId,
    priority: taskData.priority || 'medium',
    tags: Array.isArray(taskData.tags) ? [...taskData.tags] : [],
    dueDate: taskData.dueDate || null,
    createdAt: taskData.createdAt || new Date(currentTime).toISOString(),
    completedAt: columnId === 'done' ? (taskData.completedAt || new Date(currentTime).toISOString()) : null,
    order: maxOrder + 1
  };

  return [...tasks, newTask];
}

export function updateTask(tasks, taskId, updates, currentTime) {
  const index = tasks.findIndex(t => t.id === taskId);
  if (index === -1) {
    throw new Error('Görev bulunamadı.');
  }

  const task = tasks[index];
  const updatedColumnId = updates.columnId !== undefined ? updates.columnId : task.columnId;
  if (!['todo', 'in_progress', 'done'].includes(updatedColumnId)) {
    throw new Error('Geçersiz sütun ID.');
  }

  let completedAt = task.completedAt;
  if (updatedColumnId === 'done' && task.columnId !== 'done') {
    completedAt = new Date(currentTime).toISOString();
  } else if (updatedColumnId !== 'done' && task.columnId === 'done') {
    completedAt = null;
  }

  const updatedTask = {
    ...task,
    ...updates,
    title: updates.title !== undefined ? updates.title.trim() : task.title,
    description: updates.description !== undefined ? updates.description.trim() : task.description,
    columnId: updatedColumnId,
    completedAt
  };

  if (!updatedTask.title) {
    throw new Error('Görev başlığı boş olamaz.');
  }

  const newTasks = [...tasks];
  newTasks[index] = updatedTask;
  return newTasks;
}

export function deleteTask(tasks, taskId) {
  const index = tasks.findIndex(t => t.id === taskId);
  if (index === -1) {
    throw new Error('Görev bulunamadı.');
  }
  return tasks.filter(t => t.id !== taskId);
}

export function moveTask(tasks, taskId, targetColumnId, targetIndex, currentTime) {
  if (!['todo', 'in_progress', 'done'].includes(targetColumnId)) {
    throw new Error('Geçersiz hedef sütun.');
  }

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error('Görev bulunamadı.');
  }

  const task = tasks[taskIndex];
  const sourceColumnId = task.columnId;

  let completedAt = task.completedAt;
  if (targetColumnId === 'done' && sourceColumnId !== 'done') {
    completedAt = new Date(currentTime).toISOString();
  } else if (targetColumnId !== 'done' && sourceColumnId === 'done') {
    completedAt = null;
  }

  // Remove task from old list
  const withoutTask = tasks.filter(t => t.id !== taskId);

  // Rebuild source column tasks if source column is different from target column
  const sourceColTasks = sourceColumnId !== targetColumnId
    ? withoutTask
        .filter(t => t.columnId === sourceColumnId)
        .sort((a, b) => a.order - b.order)
        .map((t, idx) => ({ ...t, order: idx }))
    : [];

  // Get target col tasks without the moved task
  const targetColTasks = withoutTask
    .filter(t => t.columnId === targetColumnId && t.id !== taskId)
    .sort((a, b) => a.order - b.order);

  const updatedMovedTask = {
    ...task,
    columnId: targetColumnId,
    completedAt
  };

  targetColTasks.splice(targetIndex, 0, updatedMovedTask);

  const reindexedTargetTasks = targetColTasks.map((t, idx) => ({ ...t, order: idx }));

  // Combine all tasks, keeping other columns intact
  const otherTasks = withoutTask.filter(t => t.columnId !== sourceColumnId && t.columnId !== targetColumnId);

  return [...otherTasks, ...sourceColTasks, ...reindexedTargetTasks];
}

export function filterAndSearchTasks(tasks, query, filterPriority, filterTag, filterOverdue, currentTime) {
  const q = (query || '').toLowerCase().trim();

  return tasks.filter(task => {
    // Search query
    if (q) {
      const matchTitle = task.title.toLowerCase().includes(q);
      const matchDesc = task.description && task.description.toLowerCase().includes(q);
      const matchTag = task.tags.some(t => t.toLowerCase().includes(q));
      if (!matchTitle && !matchDesc && !matchTag) return false;
    }

    // Priority filter
    if (filterPriority && filterPriority !== 'all' && task.priority !== filterPriority) {
      return false;
    }

    // Tag filter
    if (filterTag && filterTag !== 'all' && !task.tags.includes(filterTag)) {
      return false;
    }

    // Overdue filter
    if (filterOverdue) {
      const status = computeDueStatus(task.dueDate, task.columnId === 'done', currentTime);
      if (status !== 'overdue') return false;
    }

    return true;
  });
}

export function computeDueStatus(dueDate, isCompleted, currentTime) {
  if (!dueDate || isCompleted) return 'no_due';

  const due = new Date(dueDate).getTime();
  const now = new Date(currentTime).getTime();
  const diff = due - now;

  if (diff < 0) return 'overdue';
  if (diff <= 24 * 60 * 60 * 1000) return 'due_soon';
  return 'on_track';
}

export function calculateStatistics(tasks, currentTime) {
  const now = new Date(currentTime);
  const todayStr = now.toISOString().split('T')[0];

  const sevenDaysAgo = new Date(currentTime);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  let completedToday = 0;
  let completedThisWeek = 0;
  let overdueCount = 0;

  tasks.forEach(task => {
    const isDone = task.columnId === 'done';
    if (isDone && task.completedAt) {
      const compDateStr = task.completedAt.split('T')[0];
      if (compDateStr === todayStr) {
        completedToday++;
      }
      const compTime = new Date(task.completedAt).getTime();
      if (compTime >= sevenDaysAgo.getTime()) {
        completedThisWeek++;
      }
    }

    if (!isDone && computeDueStatus(task.dueDate, false, currentTime) === 'overdue') {
      overdueCount++;
    }
  });

  const total = tasks.length;
  const totalDone = tasks.filter(t => t.columnId === 'done').length;
  const completionRate = total > 0 ? Math.round((totalDone / total) * 100) : 0;

  return {
    completedToday,
    completedThisWeek,
    overdueCount,
    totalTasks: total,
    totalDone,
    completionRate
  };
}

export function generateDailyAgendaTemplate(currentTime) {
  const baseDate = new Date(currentTime);
  const endOfDay = new Date(baseDate.setHours(18, 0, 0, 0)).toISOString();

  return [
    {
      id: `agenda_1_${currentTime}`,
      title: 'Günün en önemli hedefi (MIT) tamamla',
      description: 'Bugünkü en kritik göreve odaklan ve ilk 2 saatte bitir.',
      columnId: 'todo',
      priority: 'urgent',
      tags: ['Odak', 'İş'],
      dueDate: endOfDay,
      createdAt: new Date(currentTime).toISOString(),
      completedAt: null,
      order: 0
    },
    {
      id: `agenda_2_${currentTime}`,
      title: 'E-postaları ve mesajları yanıtla',
      description: 'Gelen kutusunu temizle ve acil talepleri organize et.',
      columnId: 'todo',
      priority: 'medium',
      tags: ['İletişim'],
      dueDate: endOfDay,
      createdAt: new Date(currentTime).toISOString(),
      completedAt: null,
      order: 1
    },
    {
      id: `agenda_3_${currentTime}`,
      title: 'Günlük değerlendirme ve planlama',
      description: 'Yarın yapılacaklar listesini gözden geçir ve hazırla.',
      columnId: 'todo',
      priority: 'low',
      tags: ['Plan'],
      dueDate: endOfDay,
      createdAt: new Date(currentTime).toISOString(),
      completedAt: null,
      order: 2
    }
  ];
}

export function validateAndImportData(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    if (!data || typeof data !== 'object') {
      return { success: false, data: null, error: 'Geçersiz JSON formatı.' };
    }

    if (!Array.isArray(data.tasks)) {
      return { success: false, data: null, error: 'Veride "tasks" dizisi eksik.' };
    }

    for (const t of data.tasks) {
      if (!t.id || typeof t.title !== 'string' || !['todo', 'in_progress', 'done'].includes(t.columnId)) {
        return { success: false, data: null, error: 'Görev şeması geçersiz veya sütun ID hatalı.' };
      }
    }

    return {
      success: true,
      data: {
        tasks: data.tasks,
        tags: Array.isArray(data.tags) ? data.tags : ['İş', 'Kişisel', 'Acil', 'Odak'],
        settings: typeof data.settings === 'object' && data.settings !== null ? data.settings : { soundEnabled: true }
      },
      error: null
    };
  } catch (e) {
    return { success: false, data: null, error: 'JSON ayrıştırılamadı: ' + e.message };
  }
}
