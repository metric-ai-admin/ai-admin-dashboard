/**
 * AI Admin Dashboard — shared MCP tool definitions.
 *
 * Single source of truth for every tool exposed to Claude, used by BOTH
 * transports:
 *  - mcp-server.mjs (stdio, for Claude Desktop talking to the local dashboard)
 *  - server.js's /mcp route (StreamableHTTP, for the cloud instance)
 *
 * Every tool here just calls the dashboard's own REST API (via the
 * getJSON/doFetch helpers passed in) — there is no business logic duplicated
 * here, only the tool-to-endpoint mapping.
 */

const { z } = require('zod');

function registerAllTools(server, { BASE, getJSON, doFetch, text }) {
  // ── Task Manager ──────────────────────────────────────────────────────────

  server.registerTool('get_operational_tasks', {
    title: 'Ver tareas del AI Admin',
    description: 'Devuelve las tareas del Task Manager: seguimientos de Lyndsay Review, "To Review Together", admin requests, tareas de plataforma, e importaciones de Asana.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/tasks')));

  server.registerTool('add_operational_task', {
    title: 'Agregar tarea',
    description: 'Crea una nueva tarea en el Task Manager. Úsala cuando surja algo que hay que hacer y quieras registrarlo.',
    inputSchema: {
      title: z.string().describe('Descripción corta de la tarea (requerido)'),
      type: z.enum(['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other'])
        .optional().describe('Tipo de tarea'),
      source: z.string().optional().describe('De dónde vino (p. ej. "Lyndsay", "Roxanne", correo, WhatsApp)'),
      priority: z.enum(['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done']).optional(),
      notes: z.string().optional().describe('Notas o contexto adicional'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not create the task: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task created with id ${data.id}`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running? Start it with "Iniciar AI Admin Dashboard.bat".');
    }
  });

  server.registerTool('update_operational_task', {
    title: 'Modificar tarea',
    description: 'Actualiza campos de una tarea existente por su id (usa get_operational_tasks para ver los ids).',
    inputSchema: {
      id: z.string().describe('El id de la tarea, p. ej. "task_1719421234567_4892"'),
      title: z.string().optional(),
      type: z.enum(['Lyndsay Review', 'To Review Together', 'Admin Request', 'Email Follow-up', 'Platform Build', 'Asana Import', 'Other']).optional(),
      source: z.string().optional(),
      priority: z.enum(['🔴 Critical', '🟡 Follow-up', '🟢 In Progress', '✅ Done']).optional().describe('Cambia a "✅ Done" para marcarla como completada.'),
      notes: z.string().optional(),
    },
  }, async ({ id, ...fields }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not update the task: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task "${data.title}" updated`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('complete_operational_task', {
    title: 'Marcar tarea como completada',
    description: 'Marca una tarea como completada (Done). Úsala cuando Arturo diga que terminó algo.',
    inputSchema: { id: z.string().describe('El id de la tarea — obténlo con get_operational_tasks') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task "${data.title}" marked complete`, task: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('delete_operational_task', {
    title: 'Eliminar tarea',
    description: 'Elimina una tarea permanentemente por su id. Confirma siempre con Arturo antes de eliminar.',
    inputSchema: { id: z.string().describe('El id de la tarea a eliminar') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '🗑️ Task deleted' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── SOPs ──────────────────────────────────────────────────────────────────

  server.registerTool('list_sops', {
    title: 'Listar SOPs',
    description: 'Lista todos los procedimientos (SOPs) en la base de conocimiento del AI Admin, incluyendo fuente, categoría y enlace a Slab (slab_url) cuando exista, para poder compartirlo.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/sops')));

  server.registerTool('get_sop', {
    title: 'Leer un SOP completo',
    description: 'Devuelve el texto completo de un SOP por su id (usa list_sops para obtener los ids).',
    inputSchema: { id: z.string().describe('El id del SOP, p. ej. sop_email_folders') },
  }, async ({ id }) => text(await getJSON(`/api/sops/${encodeURIComponent(id)}`)));

  server.registerTool('search_sops', {
    title: 'Buscar en los SOPs',
    description: 'Busca un término en todos los SOPs y devuelve los fragmentos que coinciden.',
    inputSchema: { query: z.string().describe('Término o frase a buscar') },
  }, async ({ query }) => text(await getJSON(`/api/sops/search/${encodeURIComponent(query)}`)));

  server.registerTool('add_sop', {
    title: 'Agregar un SOP',
    description: 'Agrega un nuevo procedimiento a la base de conocimiento (p. ej. dirección de redirección de facturas, reglas de calendario).',
    inputSchema: {
      title: z.string().describe('Título del SOP'),
      text: z.string().describe('Texto completo del procedimiento'),
      tags: z.array(z.string()).optional().describe('Etiquetas opcionales, p. ej. ["email","calendario"]'),
      source: z.string().optional().describe('Fuente, p. ej. "Slab — metric.slab.com" o "Jay Manuel — 08/14/2026"'),
      category: z.string().optional().describe('Categoría, p. ej. "Email Management"'),
      slab_url: z.string().optional().describe('Enlace al artículo original en Slab, si existe'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/sops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ SOP "${data.title}" added`, sop: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── Asana ─────────────────────────────────────────────────────────────────

  server.registerTool('get_my_asana_tasks', {
    title: 'Mis tareas de Asana',
    description: 'Devuelve las tareas de Asana asignadas a Arturo (o donde participa), de los proyectos conectados al AI Admin dashboard.',
    inputSchema: {},
  }, async () => {
    const me = await getJSON('/api/asana/me');
    const data = await getJSON('/api/asana/tasks');
    if (data._error) return text(data._error);
    const myGid = me && me.gid;
    const mine = myGid ? data.tasks.filter(t => t.assignee_gid === myGid || (t.follower_gids || []).includes(myGid)) : data.tasks;
    const simplified = mine.map(t => ({
      name: t.name, project: t.project, due_on: t.due_on,
      completed: t.completed, assignee: t.assignee, notes: t.notes_preview,
    }));
    return text({ count: simplified.length, lastUpdated: data.lastUpdated, tasks: simplified });
  });

  server.registerTool('import_asana_tasks', {
    title: 'Importar tareas de Asana al Task Manager',
    description: 'Importa las tareas abiertas de un proyecto de Asana (por su gid) al Task Manager del dashboard, para que aparezcan junto con el resto de las tareas del AI Admin en un solo lugar. No completa ni edita tareas en Asana — solo lectura/importación.',
    inputSchema: {
      projectGid: z.string().describe('El gid del proyecto de Asana del que importar tareas'),
    },
  }, async ({ projectGid }) => {
    try {
      const res = await doFetch(`${BASE}/api/asana/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectGid }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Could not import: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ ${data.imported} new tasks imported (of ${data.total} open in the project)`, imported: data.imported, total: data.total });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── Platform Projects Tracker ─────────────────────────────────────────────

  server.registerTool('get_platform_projects', {
    title: 'Ver seguimiento de la plataforma multi-departamento',
    description: 'Devuelve el estado de cada módulo de la Unified Operations Platform (BD CRM, Leasing Goal Board, Application Approval Board, Eviction Tracker, Operations Aggregate View): fase, bloqueos, última actualización y siguiente acción.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/platform-projects')));

  server.registerTool('update_platform_project', {
    title: 'Actualizar un módulo de la plataforma',
    description: 'Actualiza la fase, bloqueos o siguiente acción de un módulo del Unified Operations Platform build. Usa get_platform_projects para ver los ids.',
    inputSchema: {
      id: z.string().describe('El id del proyecto, p. ej. "proj_bd_crm" — obténlo con get_platform_projects'),
      phase: z.enum(['Not started', 'Discovery', 'In Development', 'Testing', 'Live']).optional(),
      blockers: z.string().optional(),
      nextAction: z.string().optional(),
    },
  }, async ({ id, ...fields }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ "${data.module}" moved to phase "${data.phase}"`, project: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('add_platform_project', {
    title: 'Crear un nuevo proyecto en el Platform Projects Tracker',
    description: 'Crea un nuevo módulo/proyecto en el Unified Operations Platform build tracker. Útil para registrar nuevos proyectos sin necesitar el web UI.',
    inputSchema: {
      id: z.string().optional().describe('ID personalizado, p. ej. "proj_maintenance_dashboard". Si se omite se genera automáticamente.'),
      module: z.string().describe('Nombre del módulo o proyecto'),
      phase: z.enum(['Not started', 'Discovery', 'In Development', 'Testing', 'Live']).optional(),
      order: z.number().optional().describe('Posición en la lista (número entero)'),
      nextAction: z.string().optional(),
      blockers: z.string().optional(),
    },
  }, async ({ id, module, phase, order, nextAction, blockers }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, module, phase, order, nextAction, blockers }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Project "${data.module}" created with id "${data.id}"`, project: data });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('add_platform_project_subtask', {
    title: 'Agregar un subtask a un proyecto de la plataforma',
    description: 'Agrega un subtask a un proyecto existente en el Platform Projects Tracker. Usa get_platform_projects para obtener el id del proyecto.',
    inputSchema: {
      projectId: z.string().describe('El id del proyecto, p. ej. "proj_bd_crm"'),
      title: z.string().describe('Título del subtask'),
      done: z.boolean().optional().describe('Si el subtask ya está completado (default: false)'),
    },
  }, async ({ projectId, title, done }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(projectId)}/subtasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, done: done === true }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      const sub = (data.subtasks || []).slice(-1)[0];
      return text({ ok: true, message: `✅ Subtask "${sub?.title}" added to project "${data.module}"`, subtask: sub });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('complete_platform_project_subtask', {
    title: 'Marcar un subtask como done/undone',
    description: 'Cambia el estado done/undone de un subtask. Usa get_platform_projects para obtener el projectId y subId.',
    inputSchema: {
      projectId: z.string().describe('El id del proyecto'),
      subId: z.string().describe('El id del subtask, p. ej. "sub_1787589937376_3761"'),
      done: z.boolean().describe('true = completado, false = pendiente'),
    },
  }, async ({ projectId, subId, done }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(projectId)}/subtasks/${encodeURIComponent(subId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      const sub = (data.subtasks || []).find(s => s.id === subId);
      return text({ ok: true, message: `✅ Subtask "${sub?.title}" marked as ${done ? 'done' : 'pending'}`, subtask: sub });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  server.registerTool('delete_platform_project', {
    title: 'Eliminar un proyecto del Platform Projects Tracker',
    description: 'Elimina permanentemente un proyecto del tracker. Usa get_platform_projects para confirmar el id antes de borrar.',
    inputSchema: {
      id: z.string().describe('El id del proyecto a eliminar'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/platform-projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Project "${data.deleted}" deleted` });
    } catch {
      return text('Could not reach the dashboard.');
    }
  });

  // ── Email / Calendar (stub until Graph API credentials are set) ──────────

  server.registerTool('get_email_triage_status', {
    title: 'Estado de triage de correo',
    description: 'Devuelve el conteo real de correos no leídos y totales en el Inbox de ambos buzones (Lyndsay y Arturo), más los remitentes más frecuentes sin leer de Lyndsay. Requiere Graph API conectado — si no, indica configured:false o authRequired:true.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/triage')));

  server.registerTool('get_lyndsay_inbox', {
    title: 'Leer el inbox de Lyndsay (o de Arturo)',
    description: 'Lee correos del Inbox de Lyndsay (o de Arturo) vía Graph API — remitente, asunto, preview, si está leído y si tiene adjuntos. Úsalo para el triage diario: Claude lee y clasifica correos sin necesitar Chrome ni Outlook abiertos. Solo lectura — no marca como leído, no mueve ni elimina nada.',
    inputSchema: {
      mailbox: z.enum(['lyndsay', 'arturo', 'both']).optional().describe('Qué buzón leer. Por defecto: lyndsay'),
      limit: z.number().optional().describe('Número de correos a devolver. Por defecto: 50, máximo: 100'),
      unread_only: z.boolean().optional().describe('Si es true, devuelve solo correos no leídos. Por defecto: false'),
    },
  }, async ({ mailbox, limit, unread_only } = {}) => {
    const params = new URLSearchParams();
    if (mailbox) params.set('mailbox', mailbox);
    if (limit) params.set('limit', String(limit));
    if (unread_only) params.set('unread', 'true');
    const qs = params.toString();
    return text(await getJSON(`/api/email/inbox${qs ? `?${qs}` : ''}`));
  });

  server.registerTool('get_email_body', {
    title: 'Leer el cuerpo completo de un correo',
    description: 'Lee el cuerpo completo de un correo específico por su Graph message ID. Úsalo después de get_lyndsay_inbox cuando necesites más contexto para clasificar un correo correctamente. Solo lectura.',
    inputSchema: {
      message_id: z.string().describe('El Graph message ID obtenido con get_lyndsay_inbox'),
      mailbox: z.enum(['lyndsay', 'arturo']).describe('A qué buzón pertenece el mensaje'),
    },
  }, async ({ message_id, mailbox }) => text(await getJSON(`/api/email/message/${encodeURIComponent(message_id)}?mailbox=${mailbox}`)));

  server.registerTool('get_lyndsay_folders', {
    title: 'Listar carpetas del correo de Lyndsay',
    description: 'Lista todas las carpetas del buzón de Lyndsay (o de Arturo) con su conteo de no leídos y total. Úsalo para descubrir qué carpetas existen (Lyndsay Review, Need to File, Rhoxie To Do, Client Emails, etc.) antes de leer una específica con get_lyndsay_folder_emails.',
    inputSchema: {
      mailbox: z.enum(['lyndsay', 'arturo', 'both']).optional().describe('Qué buzón listar. Por defecto: lyndsay'),
    },
  }, async ({ mailbox } = {}) => text(await getJSON(`/api/email/folders${mailbox ? `?mailbox=${mailbox}` : ''}`)));

  server.registerTool('get_lyndsay_folder_emails', {
    title: 'Leer correos de una carpeta específica',
    description: 'Lee correos de una carpeta específica del buzón de Lyndsay (o de Arturo) — no solo el Inbox. Usa el nombre de carpeta exactamente como lo devuelve get_lyndsay_folders (p. ej. "Need to File", "Lyndsay Review", "Rhoxie To Do"). Solo lectura.',
    inputSchema: {
      folder_name: z.string().describe('Nombre exacto de la carpeta, p. ej. "Need to File", "Lyndsay Review", "Rhoxie To Do"'),
      mailbox: z.enum(['lyndsay', 'arturo']).optional().describe('A qué buzón pertenece la carpeta. Por defecto: lyndsay'),
      limit: z.number().optional().describe('Máximo de correos a devolver. Por defecto: 25'),
      unread_only: z.boolean().optional().describe('Si es true, devuelve solo correos no leídos. Por defecto: false'),
    },
  }, async ({ folder_name, mailbox, limit, unread_only } = {}) => {
    const params = new URLSearchParams();
    params.set('folder', folder_name);
    params.set('mailbox', mailbox || 'lyndsay');
    params.set('limit', String(limit || 25));
    if (unread_only) params.set('unread', 'true');
    return text(await getJSON(`/api/email/inbox?${params.toString()}`));
  });

  server.registerTool('search_lyndsay_email', {
    title: 'Buscar correos en todas las carpetas',
    description: 'Busca en TODAS las carpetas del buzón de Lyndsay (o de Arturo) — no solo el Inbox — por un término. Úsalo cuando necesites encontrar un correo específico (factura, recibo, etc.) sin saber en qué de las ~65 carpetas está.',
    inputSchema: {
      query: z.string().describe('Término de búsqueda, p. ej. "recibo de OpenAI", "factura de Slab"'),
      mailbox: z.enum(['lyndsay', 'arturo']).optional().describe('Qué buzón buscar. Por defecto: lyndsay'),
      limit: z.number().optional().describe('Máximo de resultados. Por defecto: 10'),
    },
  }, async ({ query, mailbox, limit } = {}) => {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('mailbox', mailbox || 'lyndsay');
    params.set('limit', String(limit || 10));
    return text(await getJSON(`/api/email/search?${params.toString()}`));
  });

  server.registerTool('get_flagged_for_lyndsay', {
    title: 'Elementos marcados para Lyndsay',
    description: 'Devuelve los correos/elementos que requieren el juicio de Arturo antes de decidir si Lyndsay necesita verlos.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/flagged-for-lyndsay')));

  server.registerTool('mark_email_handled', {
    title: 'Marcar correo como atendido',
    description: 'Marca un elemento de correo marcado ("flagged") como ya atendido.',
    inputSchema: { id: z.string().describe('El id del elemento marcado — obtenlo con get_flagged_for_lyndsay') },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/email/${encodeURIComponent(id)}/handled`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Marked as handled' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('get_todays_meetings', {
    title: 'Reuniones de hoy',
    description: 'Devuelve las reuniones de hoy con hora, plataforma (Teams/Zoom/presencial) y asistentes, filtrable por buzón ("arturo" | "lyndsay"). Marca conflictos entre ambos calendarios. Modo stub hasta que se configure el Graph API.',
    inputSchema: { mailbox: z.enum(['arturo', 'lyndsay']).optional().describe('Filtrar por calendario; si se omite devuelve ambos') },
  }, async ({ mailbox } = {}) => text(await getJSON(`/api/calendar/today${mailbox ? `?mailbox=${mailbox}` : ''}`)));

  server.registerTool('get_pending_lyndsay_messages', {
    title: 'Cola de mensajes listos para Lyndsay',
    description: 'Devuelve la cola de mensajes de recordatorio listos para copiar y enviar a Lyndsay (WhatsApp/llamada). Incluye recordatorios auto-generados desde su calendario y mensajes agregados manualmente. NUNCA se envían automáticamente.',
    inputSchema: {},
  }, async () => {
    const queue = await getJSON('/api/lyndsay-queue');
    if (queue._error) return text(queue._error);
    const shaped = queue.map(q => ({
      id: q.id,
      eventId: q.eventId || null,
      message: q.text,
      meetingTitle: q.meetingTitle || null,
      meetingTime: q.meetingTime || null,
      meetingType: q.meetingType || null,
      reminderMinutesBefore: q.reminderMinutesBefore ?? null,
      createdAt: q.createdAt,
      sent: !!q.sent,
    }));
    return text(shaped);
  });

  server.registerTool('get_inbox_tracking', {
    title: 'Inbox Tracking — todos los buzones y carpetas personales de Metric',
    description: 'Devuelve el conteo de correos no leídos y totales de cada fila rastreada en el reporte diario de Inbox Tracking: tanto el Inbox de cada buzón departamental (support, collections, hello, maintenance, leasing, accounting, marketing, admin) como las carpetas personales asignadas a cada persona dentro de esos buzones (p. ej. la carpeta "Arturo" dentro de support@, "Karla" dentro de collections@). Reemplaza el proceso manual donde cada persona reporta su propio conteo. El mapeo completo de filas está en INBOX_TRACKING_MAPPING (.env).',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/inbox-tracking')));

  server.registerTool('get_all_folders_tracking', {
    title: 'Todas las carpetas de todos los buzones de Metric',
    description: 'Lista todas las carpetas con su conteo de no leídos en TODOS los buzones de Metric (support, collections, hello, maintenance, leasing, accounting, marketing, admin). Incluye carpetas del sistema (Inbox, Sent, Deleted) y carpetas personales por persona (p. ej. "Arturo" dentro de support@, "Rocío" dentro de collections@). Esencial para automatizar el reporte completo de Inbox Tracking en SharePoint.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/email/all-folders-tracking')));

  server.registerTool('add_lyndsay_message_to_queue', {
    title: 'Agregar mensaje a la cola de Lyndsay',
    description: 'Agrega un mensaje de texto (listo para copiar/pegar) a la cola de recordatorios para Lyndsay. Nunca se envía automáticamente — Arturo lo copia y lo envía él mismo.',
    inputSchema: {
      text: z.string().describe('El texto del mensaje, listo para copiar y pegar'),
      reason: z.string().optional().describe('Por qué se está enviando este mensaje (p. ej. "Reunión en 30 min", "Necesita firmar X")'),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay-queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Message added to the queue', item: data });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  server.registerTool('mark_lyndsay_message_sent', {
    title: 'Marcar mensaje de Lyndsay como enviado',
    description: 'Marca un mensaje de la cola de Lyndsay como ya enviado, para que desaparezca de la cola pendiente. Úsalo después de que Arturo confirme que copió y envió el mensaje por WhatsApp o llamada.',
    inputSchema: {
      id: z.string().describe('El id del mensaje — obténlo con get_pending_lyndsay_messages'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay-queue/${encodeURIComponent(id)}/sent`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: '✅ Message marked as sent' });
    } catch {
      return text('Could not reach the dashboard. Is it running?');
    }
  });

  // ── End of Day Summary ────────────────────────────────────────────────────

  server.registerTool('get_end_of_day_summary', {
    title: 'Resumen de fin de día',
    description: 'Resumen de fin de día: tareas completadas y abiertas, reuniones de hoy, elementos aún marcados para Lyndsay, y las prioridades top para mañana. Formato de viñetas listo para compartir con Lyndsay.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/summary')));

  // ══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE TOOLS — Erick Frey (Maintenance Coordinator)
  // These tools operate on metric-dashboard data: operational_tasks,
  // property_assignments, lyndsay_snapshots, and the AppFolio analyzer.
  // All names are prefixed with "maintenance_" to avoid collision with the
  // AI Admin tools above (which target Arturo's /api/tasks, not Erick's
  // /api/operational or the Supabase operational_tasks table).
  // ══════════════════════════════════════════════════════════════════════════

  server.registerTool('maintenance_get_tasks', {
    title: 'Ver tareas de mantenimiento',
    description: 'Devuelve todas las tareas del tablero de mantenimiento de Erick (operational_tasks en Supabase). Incluye prioridad, persona responsable, notas e historial.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/operational')));

  server.registerTool('maintenance_add_task', {
    title: 'Agregar tarea de mantenimiento',
    description: 'Crea una nueva tarea en el tablero de mantenimiento de Erick.',
    inputSchema: {
      title: z.string().describe('Descripción de la tarea (requerido)'),
      type: z.enum(['WO Follow-up','Translation','Resident Contact','Tech Contact','Escalation','Billing QC','Daily Recurring','Other']).optional(),
      person: z.string().optional().describe('Técnico o persona responsable'),
      action: z.string().optional().describe('Acción a tomar o contexto detallado'),
      priority: z.enum(['🔴 Critical','🟡 Follow-up','🟢 In Progress','🔁 Daily Task','✅ Done']).optional(),
      notes: z.string().optional(),
    },
  }, async (params) => {
    try {
      const res = await doFetch(`${BASE}/api/operational`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task created (${data.id})`, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_update_task', {
    title: 'Modificar tarea de mantenimiento',
    description: 'Actualiza campos de una tarea existente en el tablero de Erick. Pasar notes agrega una entrada al historial.',
    inputSchema: {
      id: z.string().describe('ID de la tarea (op_...)'),
      title: z.string().optional(),
      type: z.enum(['WO Follow-up','Translation','Resident Contact','Tech Contact','Escalation','Billing QC','Daily Recurring','Other']).optional(),
      person: z.string().optional(),
      action: z.string().optional(),
      priority: z.enum(['🔴 Critical','🟡 Follow-up','🟢 In Progress','🔁 Daily Task','✅ Done']).optional(),
      notes: z.string().optional().describe('Nota a agregar al historial'),
    },
  }, async ({ id, ...rest }) => {
    try {
      const res = await doFetch(`${BASE}/api/operational/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rest) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_complete_task', {
    title: 'Completar tarea de mantenimiento',
    description: 'Marca una tarea de mantenimiento de Erick como completada.',
    inputSchema: {
      id: z.string().describe('ID de la tarea (op_...)'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/operational/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task completed`, task: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_property_assignments', {
    title: 'Ver asignaciones por propiedad',
    description: 'Devuelve la tabla de asignaciones de mantenimiento por propiedad: técnico de grounds, técnico de mantenimiento, pest control, landscaping.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/assignments')));

  server.registerTool('maintenance_update_property', {
    title: 'Actualizar asignación de propiedad',
    description: 'Actualiza los campos de asignación de una propiedad específica.',
    inputSchema: {
      property: z.string().describe('Nombre exacto de la propiedad'),
      units: z.number().optional(),
      hasPool: z.boolean().optional(),
      groundsTech: z.string().optional(),
      groundsFrequency: z.string().optional(),
      maintenanceTech: z.string().optional(),
      pestControl: z.string().optional(),
      landscaping: z.string().optional(),
    },
  }, async ({ property, ...rest }) => {
    try {
      const res = await doFetch(`${BASE}/api/assignments/${encodeURIComponent(property)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ property, ...rest }) });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, assignment: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  // ── Technicians ───────────────────────────────────────────────────────────
  // Backed by the Supabase `technicians` table, the single source of truth that
  // replaced the five hardcoded lists (supabase/migrations/002_technicians.sql).

  server.registerTool('maintenance_list_technicians', {
    title: 'Ver técnicos',
    description: 'Lista los técnicos de mantenimiento con su posición, propiedades asignadas, capacidades (AC, plomería, eléctrico, etc.) y sus nombres en AppFolio. Úsala para decidir a quién asignar un work order según su calificación.',
    inputSchema: {
      includeInactive: z.boolean().optional().describe('Incluir técnicos dados de baja (por defecto solo activos)'),
    },
  }, async ({ includeInactive }) =>
    text(await getJSON('/api/technicians?active=' + (includeInactive ? 'all' : '1'))));

  server.registerTool('maintenance_add_technician', {
    title: 'Agregar técnico',
    description: 'Registra un técnico nuevo. El id se genera del nombre si no lo especificas. appfolioAliases debe traer el nombre EXACTO como aparece en AppFolio (suele llevar inicial al final, p. ej. "Angel Martinez C"), porque de ahí depende la alerta de cero horas.',
    inputSchema: {
      fullName: z.string().describe('Nombre completo (requerido)'),
      position: z.enum(['field_supervisor', 'senior_maint_tech', 'maint_tech', 'make_ready', 'housekeeper', 'grounds', 'other']).optional(),
      appfolioAliases: z.array(z.string()).optional().describe('Nombres exactos en AppFolio'),
      expectDailyHours: z.boolean().optional().describe('Debe registrar horas a diario — activa la alerta de cero horas'),
      propertiesLabel: z.string().optional(),
      notes: z.string().optional(),
    },
  }, async ({ fullName, position, appfolioAliases, expectDailyHours, propertiesLabel, notes }) => {
    try {
      const res = await doFetch(`${BASE}/api/technicians`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName, position, appfolio_aliases: appfolioAliases,
          expect_daily_hours: expectDailyHours, properties_label: propertiesLabel, notes,
        }),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, technician: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_update_technician', {
    title: 'Actualizar técnico',
    description: 'Actualiza un técnico existente: posición, capacidades, alias de AppFolio, ubicación en el mapa, o darlo de baja con active:false. Usa maintenance_list_technicians para ver los ids. Las capacidades aceptan: highest, yes, minor, maybe, no, na.',
    inputSchema: {
      id: z.string().describe('El id del técnico, p. ej. "angel-martinez"'),
      fullName: z.string().optional(),
      active: z.boolean().optional().describe('false para dar de baja sin borrar el historial'),
      position: z.enum(['field_supervisor', 'senior_maint_tech', 'maint_tech', 'make_ready', 'housekeeper', 'grounds', 'other']).optional(),
      appfolioAliases: z.array(z.string()).optional(),
      expectDailyHours: z.boolean().optional(),
      showOnMap: z.boolean().optional(),
      homeZip: z.string().optional(),
      homeLat: z.number().optional(),
      homeLng: z.number().optional(),
      showsInMakeReady: z.boolean().optional(),
      propertiesLabel: z.string().optional(),
      capAc: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capElectrical: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPlumbing: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPool: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capWelding: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capPainting: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capResurfacing: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      capCleaning: z.enum(['highest', 'yes', 'minor', 'maybe', 'no', 'na']).optional(),
      notes: z.string().optional(),
    },
  }, async ({ id, ...rest }) => {
    const map = {
      fullName: 'full_name', active: 'active', position: 'position',
      appfolioAliases: 'appfolio_aliases', expectDailyHours: 'expect_daily_hours',
      showOnMap: 'show_on_map', homeZip: 'home_zip', homeLat: 'home_lat', homeLng: 'home_lng',
      showsInMakeReady: 'shows_in_make_ready', propertiesLabel: 'properties_label',
      capAc: 'cap_ac', capElectrical: 'cap_electrical', capPlumbing: 'cap_plumbing',
      capPool: 'cap_pool', capWelding: 'cap_welding', capPainting: 'cap_painting',
      capResurfacing: 'cap_resurfacing', capCleaning: 'cap_cleaning', notes: 'notes',
    };
    const body = {};
    for (const [camel, snake] of Object.entries(map)) {
      if (rest[camel] !== undefined) body[snake] = rest[camel];
    }
    if (!Object.keys(body).length) return text('No se envió ningún campo para actualizar.');
    try {
      const res = await doFetch(`${BASE}/api/technicians/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, technician: data });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_lyndsay_tasks', {
    title: 'Ver tareas de Lyndsay (mantenimiento)',
    description: 'Devuelve el snapshot más reciente de tareas del Daily Command Center de Lyndsay con su estado de completado.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/lyndsay/tasks')));

  server.registerTool('maintenance_complete_lyndsay_task', {
    title: 'Marcar tarea de Lyndsay como hecha',
    description: 'Marca una tarea del Command Center de Lyndsay como completada. Acepta IDs de tareas (ej. "code:14986") y de rutina (ej. "routine:qc").',
    inputSchema: {
      id: z.string().describe('ID de la tarea (p. ej. "code:14986" o "routine:qc")'),
    },
  }, async ({ id }) => {
    try {
      const res = await doFetch(`${BASE}/api/lyndsay/tasks/${encodeURIComponent(id)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) return text(`Error: ${data.error || res.status}`);
      return text({ ok: true, message: `✅ Task marked done`, id });
    } catch { return text('Could not reach the dashboard.'); }
  });

  server.registerTool('maintenance_get_appfolio_analysis', {
    title: 'Ver análisis AppFolio más reciente',
    description: 'Devuelve el análisis más reciente de work orders de AppFolio: grupos urgent, followup, ready for QC.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/appfolio/latest')));

  server.registerTool('maintenance_get_eod_summary', {
    title: 'Resumen de fin de día (mantenimiento)',
    description: 'Resumen de fin de día de Erick: tareas operacionales completadas y abiertas, work orders de AppFolio, y prioridades para mañana.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/maintenance/summary')));

  server.registerTool('maintenance_get_daily_report', {
    title: 'Reporte diario de trabajo (Erick)',
    description: 'Reporte detallado de trabajo del día de Erick: tareas completadas, daily tasks, notas agregadas, y resumen de AppFolio. Listo para compartir con Lyndsay.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/report')));

  server.registerTool('maintenance_list_sops', {
    title: 'Listar SOPs de mantenimiento',
    description: 'Lista los documentos de procedimientos estándar del departamento de mantenimiento.',
    inputSchema: {},
  }, async () => text(await getJSON('/api/maintenance/sops')));

  server.registerTool('maintenance_get_sop', {
    title: 'Ver SOP de mantenimiento',
    description: 'Devuelve el contenido completo de un SOP de mantenimiento por su ID.',
    inputSchema: {
      id: z.string().describe('ID del SOP (sop_...)'),
    },
  }, async ({ id }) => text(await getJSON(`/api/maintenance/sops/${encodeURIComponent(id)}`)));

  server.registerTool('maintenance_search_sops', {
    title: 'Buscar en SOPs de mantenimiento',
    description: 'Busca por palabra clave en los SOPs de mantenimiento. Devuelve snippets relevantes.',
    inputSchema: {
      query: z.string().describe('Término de búsqueda'),
    },
  }, async ({ query }) => text(await getJSON(`/api/maintenance/sops/search/${encodeURIComponent(query)}`)));
}

module.exports = { registerAllTools };
