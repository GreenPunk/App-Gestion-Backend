/**
 * ─────────────────────────────────────────────────────────────
 *  BACKEND — SaaS Gestión Inmobiliaria
 *  Node.js + Express + docxtemplater + pizzip + Anthropic
 * ─────────────────────────────────────────────────────────────
 *
 *  ENDPOINTS:
 *    POST /api/generar-docx             → recibe plantilla + datos, devuelve .docx relleno
 *    POST /api/chat                     → chat IA con contexto del tenant (streaming SSE)
 *    POST /api/consumos/extraer-factura → extrae datos de una factura (Edenor/Naturgy/Visa) con IA
 *    GET  /api/health                   → estado del servidor
 * ─────────────────────────────────────────────────────────────
 */

const express       = require("express");
const cors          = require("cors");
const multer        = require("multer");
const PizZip        = require("pizzip");
const Docxtemplater = require("docxtemplater");
const path          = require("path");
const fs            = require("fs");
const Anthropic     = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 4000;

// Cliente Anthropic — usa ANTHROPIC_API_KEY del entorno (variable de entorno en Render)
const anthropic = new Anthropic();

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://tasaciones-inmobiliarias.vercel.app",
    "https://app-saa-s-gestion-inmobiliaria.vercel.app",
    "https://app-saa-s-gestion-inmobiliaria-nwtyoqz8u.vercel.app",
    "https://app-saa-s-gestion-inmobiliaria-9j8k2kmvb.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" }));

// Multer: recibe el archivo .docx en memoria (no lo guarda en disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || path.extname(file.originalname).toLowerCase() === ".docx") {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos .docx"));
    }
  },
});

// Multer: recibe la foto/PDF de una factura de servicios (Consumos) en memoria
const uploadFactura = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (tiposPermitidos.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Solo se permiten imágenes (jpg/png/webp) o PDF"));
  },
});

// ── Supabase fetch helper (server-side) ───────────────────────
const SB_URL = process.env.SUPABASE_URL     || "";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";

async function sbQuery(table, params = "") {
  if (!SB_URL || !SB_KEY) return [];
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      headers: {
        "apikey":        SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        "Content-Type":  "application/json",
      },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

// ── Construir contexto del tenant para el agente IA ──────────
//
// Campos reales confirmados por inspección de BD (02/06/2026):
//
// alq_contratos.data:  docId, estado ("Vigente"|"Borrador"|"Rescindido"|"Vencido"|"Vence 60d"|"Moroso"),
//                      fechaFin, fechaInicio, fechaFirma, montoActual, montoInicial,
//                      inquilinoId, propietarioId, propiedadId, pctHonorarios,
//                      diaVencimiento, periodoActualizacion, indice, notasInternas
//
// alq_pagos.data:      docId, estado ("Pagado"|"Pendiente"|"Moroso"),
//                      monto, totalCobrado, periodo, fechaPago, fechaRegistro,
//                      contratoId, metodoPago, observaciones, mora, diasMora
//
// alq_inquilinos.data: nombre, dni, telefono, telefonoWA, email, domicilio,
//                      ocupacion, estadoCivil, garanteNombre, garanteDni
//
// alq_propietarios.data: nombre, dni, telefono, telefonoWA, email,
//                        domicilio, condAfip, porcentajeRetencion
//
// alq_propiedades.data:  direccion, tipo, estado ("Alquilada"|"Disponible"|"Reservada"),
//                        barrio, localidad, partido, servicios, piso,
//                        supCubierta, supTotal, propietarioId
//
// alq_reclamos.data:   (sin datos aún — estructura por definir)
// alq_liquidaciones.data: (sin datos aún)
//
// tas_propietarios (columnas directas, sin .data):
//                      nombre, telefono, propiedad_dir, propiedad_barrio,
//                      propiedad_tipo, valor_tasacion, fecha_tasacion,
//                      agente_nombre, tasacion_op_id, origen, tenant_id
//
// tas_recordatorios (columnas directas, sin .data):
//                      agente_nombre, propietario_nombre, asunto,
//                      mensaje_personalizado, estado ("pendiente"|"enviado"|"cancelado"),
//                      canal, fecha_envio, tenant_id ← YA TIENE tenant_id
//
// operations.data:     tasaciones del módulo (valorCalc, valorManual, v110, v120,
//                      pct1, pct2, comparables, detalle, tipo, fecha, agentId)
//
// properties.data:     propiedades del módulo tasaciones (tipologia, direccion,
//                      barrio, supCubierta, supTotal, supSemicubierta, supDescubierta)

async function buildTenantContext(tenantId) {
  if (!tenantId) return "Sin tenant seleccionado — no hay datos disponibles.";

  const hoy    = new Date();
  const hoyStr = hoy.toISOString().split("T")[0];
  const en60   = new Date(hoy); en60.setDate(en60.getDate() + 60);
  const en60Str = en60.toISOString().split("T")[0];

  // ── Consultas en paralelo ────────────────────────────────────
  const [
    rawContratos, rawPagos, rawInquilinos,
    rawPropietariosAlq, rawPropiedades,
    rawTasPropietarios, rawTasRecordatorios,
    rawTasProperties, rawTasOperations,
  ] = await Promise.all([
    sbQuery("alq_contratos",    `tenant_id=eq.${tenantId}&select=id,data&order=id.asc&limit=200`),
    sbQuery("alq_pagos",        `tenant_id=eq.${tenantId}&select=id,data&order=id.desc&limit=500`),
    sbQuery("alq_inquilinos",   `tenant_id=eq.${tenantId}&select=id,data&limit=200`),
    sbQuery("alq_propietarios", `tenant_id=eq.${tenantId}&select=id,data&limit=100`),
    sbQuery("alq_propiedades",  `tenant_id=eq.${tenantId}&select=id,data&limit=200`),
    sbQuery("tas_propietarios", `tenant_id=eq.${tenantId}&select=*&order=created_at.desc&limit=100`),
    sbQuery("tas_recordatorios",`tenant_id=eq.${tenantId}&select=*&order=fecha_envio.asc&limit=100`),
    sbQuery("properties",       `tenant_id=eq.${tenantId}&select=id,data&limit=200`),
    sbQuery("operations",       `tenant_id=eq.${tenantId}&select=id,data&order=id.desc&limit=200`),
  ]);

  console.log(`[buildTenantContext] tenantId=${tenantId} → contratos=${rawContratos.length} pagos=${rawPagos.length} inquilinos=${rawInquilinos.length} propietariosAlq=${rawPropietariosAlq.length} propiedades=${rawPropiedades.length} tasProp=${rawTasPropietarios.length} tasRec=${rawTasRecordatorios.length} tasProperties=${rawTasProperties.length} tasOps=${rawTasOperations.length}`);

  // ── Parser de columna data (jsonb → objeto) ──────────────────
  const pd = (r) => {
    try { return typeof r.data === "object" ? r.data : JSON.parse(r.data); }
    catch { return null; }
  };

  // ── MÓDULO ALQUILERES ────────────────────────────────────────

  // Lookup maps para cruzar IDs
  const inquilinosMap = {};
  rawInquilinos.forEach(r => { const d = pd(r); if (d) inquilinosMap[String(d.id || r.id)] = d; });

  const propietariosAlqMap = {};
  rawPropietariosAlq.forEach(r => { const d = pd(r); if (d) propietariosAlqMap[String(d.id || r.id)] = d; });

  const propiedadesMap = {};
  rawPropiedades.forEach(r => { const d = pd(r); if (d) propiedadesMap[String(d.id || r.id)] = d; });

  // Contratos con estado calculado igual que el módulo
  // Estado guardado en DB: "Vigente" | "Borrador" | "Rescindido"
  // Estado dinámico (calculado): "Vencido" si fechaFin < hoy, "Vence 60d" si < 60d, "Moroso" si tiene pagos Morosos
  const pagosData = rawPagos.map(pd).filter(Boolean);

  const calcEstado = (c) => {
    if (!c) return "Borrador";
    if (c.estado === "Rescindido" || c.estado === "Borrador") return c.estado;
    if (c.fechaFin) {
      const fin = new Date(c.fechaFin + "T00:00:00");
      const diffDias = Math.round((fin - hoy) / 86400000);
      if (diffDias < 0) return "Vencido";
      if (diffDias <= 60) return "Vence 60d";
    }
    const tieneMora = pagosData.some(p => String(p.contratoId) === String(c.id) && p.estado === "Moroso");
    if (tieneMora) return "Moroso";
    return "Vigente";
  };

  const contratos = rawContratos.map(r => {
    const d = pd(r);
    if (!d) return null;
    const estadoEfectivo = calcEstado(d);
    const inq  = inquilinosMap[String(d.inquilinoId)]  || {};
    const prop = propietariosAlqMap[String(d.propietarioId)] || {};
    const propi = propiedadesMap[String(d.propiedadId)] || {};
    return { ...d, _estadoEfectivo: estadoEfectivo, _inquilinoNombre: inq.nombre || d.inquilinoId, _propietarioNombre: prop.nombre || d.propietarioId, _direccion: propi.direccion || d.propiedadId };
  }).filter(Boolean);

  const ACTIVOS = ["Vigente", "Vence 60d", "Moroso"];
  const contratosActivos   = contratos.filter(c => ACTIVOS.includes(c._estadoEfectivo));
  const contratosBorrador  = contratos.filter(c => c._estadoEfectivo === "Borrador");
  const contratosVencidos  = contratos.filter(c => c._estadoEfectivo === "Vencido");
  const contratosRescindidos = contratos.filter(c => c._estadoEfectivo === "Rescindido");
  const contratosVence60d  = contratos.filter(c => c._estadoEfectivo === "Vence 60d");
  const contratosMorosos   = contratos.filter(c => c._estadoEfectivo === "Moroso");

  const pagosPendientes = pagosData.filter(p => p.estado === "Pendiente" || p.estado === "Moroso");
  const pagosPagados    = pagosData.filter(p => p.estado === "Pagado");
  const periodoActual   = hoyStr.slice(0, 7); // "YYYY-MM"
  const cobradoEsteMes  = pagosData
    .filter(p => p.estado === "Pagado" && p.periodo === periodoActual)
    .reduce((a, p) => a + (parseFloat(p.totalCobrado) || 0), 0);

  const fmtPesos = n => n > 0 ? `$${n.toLocaleString("es-AR")}` : "$0";

  // ── MÓDULO TASACIONES ────────────────────────────────────────

  const tasPropietarios = rawTasPropietarios; // columnas directas, no .data
  const tasRecordatorios = rawTasRecordatorios;
  const tasRecPendientes = tasRecordatorios.filter(r => r.estado === "pendiente");
  const tasRecHoy = tasRecordatorios.filter(r => {
    if (!r.fecha_envio) return false;
    return r.fecha_envio.startsWith(hoyStr);
  });

  const tasProperties = rawTasProperties.map(pd).filter(Boolean);
  const tasOperations = rawTasOperations.map(pd).filter(Boolean);
  // Solo contar operaciones que son tasaciones reales (tienen valorCalc)
  const tasacionesConValor = tasOperations.filter(o => o.valorCalc != null);

  // ── Construcción del contexto en texto ───────────────────────
  const lines = [
    `=== CONTEXTO DE LA INMOBILIARIA (id: ${tenantId}) ===`,
    `Fecha: ${hoyStr}`,
    "",
    "── MÓDULO ALQUILERES ──",
    "",
    `CONTRATOS TOTALES: ${contratos.length}`,
    `  Vigentes: ${contratosActivos.length - contratosMorosos.length - contratosVence60d.length}  |  Por vencer (≤60d): ${contratosVence60d.length}  |  Morosos: ${contratosMorosos.length}  |  Vencidos: ${contratosVencidos.length}  |  Rescindidos: ${contratosRescindidos.length}  |  Borradores: ${contratosBorrador.length}`,
    "",
    contratosActivos.length > 0
      ? "CONTRATOS ACTIVOS:\n" + contratosActivos.map(c =>
          `  [${c._estadoEfectivo}] ${c._inquilinoNombre} · ${c._direccion} · $${c.montoActual} · vence ${c.fechaFin} · doc ${c.docId}`
        ).join("\n")
      : "CONTRATOS ACTIVOS: ninguno",
    "",
    contratosVencidos.length > 0
      ? "CONTRATOS VENCIDOS:\n" + contratosVencidos.slice(0, 5).map(c =>
          `  ${c._inquilinoNombre} · venció ${c.fechaFin} · $${c.montoActual}`
        ).join("\n")
      : "",
    "",
    `PAGOS — Cobrado este mes (${periodoActual}): ${fmtPesos(cobradoEsteMes)}`,
    `  Pendientes/Morosos: ${pagosPendientes.length}  |  Pagados total: ${pagosPagados.length}`,
    pagosPendientes.length > 0
      ? "  PENDIENTES:\n" + pagosPendientes.slice(0, 10).map(p => {
          const ct = contratos.find(c => String(c.id) === String(p.contratoId));
          return `    [${p.estado}] ${ct?._inquilinoNombre || p.contratoId} · $${p.monto} · periodo ${p.periodo}`;
        }).join("\n")
      : "",
    "",
    `PROPIETARIOS (alquileres): ${rawPropietariosAlq.length}`,
    rawPropietariosAlq.length > 0
      ? "  " + rawPropietariosAlq.map(r => { const d = pd(r); return d?.nombre || "?"; }).filter(Boolean).slice(0, 15).join(", ")
      : "  Ninguno",
    "",
    `INQUILINOS REGISTRADOS: ${rawInquilinos.length}`,
    rawInquilinos.length > 0
      ? "  " + rawInquilinos.map(r => { const d = pd(r); return d?.nombre || "?"; }).filter(Boolean).slice(0, 15).join(", ")
      : "  Ninguno",
    "",
    `PROPIEDADES: ${rawPropiedades.length}`,
    rawPropiedades.length > 0
      ? rawPropiedades.slice(0, 10).map(r => {
          const d = pd(r); if (!d) return null;
          return `  [${d.estado || "?"}] ${d.direccion || "?"} · ${d.tipo || "?"} · ${d.barrio || "?"}, ${d.localidad || ""}`;
        }).filter(Boolean).join("\n")
      : "  Ninguna",
    "",
    "── MÓDULO TASACIONES ──",
    "",
    `PROPIETARIOS EN TASACIONES: ${tasPropietarios.length}`,
    tasPropietarios.length > 0
      ? tasPropietarios.slice(0, 10).map(p =>
          `  ${p.nombre} · ${p.propiedad_tipo || "?"} en ${p.propiedad_barrio || "?"} · ${p.propiedad_dir || ""} · tasación: ${p.valor_tasacion ? fmtPesos(p.valor_tasacion) : "sin valor"} (${p.fecha_tasacion || "sin fecha"})`
        ).join("\n")
      : "  Ninguno",
    "",
    `PROPIEDADES EN TASACIONES: ${tasProperties.length}`,
    tasProperties.length > 0
      ? tasProperties.slice(0, 10).map(p =>
          `  ${p.tipologia || "?"} · ${p.direccion || "?"} · ${p.barrio || ""} · sup. cubierta: ${p.supCubierta || "?"}m²`
        ).join("\n")
      : "  Ninguna",
    "",
    `TASACIONES REALIZADAS (con valor calculado): ${tasacionesConValor.length}`,
    tasacionesConValor.length > 0
      ? tasacionesConValor.slice(0, 5).map(o =>
          `  ${o.detalle || "?"} · calc: ${fmtPesos(o.valorCalc)} · sugerido: ${o.valorManual ? fmtPesos(o.valorManual) : "—"}`
        ).join("\n")
      : "  Ninguna",
    "",
    `RECORDATORIOS (tasaciones): ${tasRecordatorios.length} total · ${tasRecPendientes.length} pendientes · ${tasRecHoy.length} para hoy`,
    tasRecPendientes.length > 0
      ? tasRecPendientes.slice(0, 5).map(r =>
          `  [${r.canal || "?"}] ${r.propietario_nombre || "?"} · "${r.asunto || r.mensaje_personalizado || "?"}" · ${r.fecha_envio ? r.fecha_envio.slice(0, 10) : "sin fecha"}`
        ).join("\n")
      : "",
    "",
    "=== FIN CONTEXTO ===",
  ].filter(s => s !== null);

  return lines.join("\n");
}

// ── ENDPOINT /api/chat ────────────────────────────────────────
/**
 * POST /api/chat
 *
 * Body JSON:
 *   {
 *     mensaje:    string,
 *     tenantId:   string | null,
 *     agentEmail: string,
 *     historial:  [{ role, content }],
 *     contexto:   string | null,   // pre-cacheado por el cliente
 *   }
 *
 * Responde con text/event-stream (Server-Sent Events).
 * Eventos: { type: "context", contexto } | { type: "delta", text } | { type: "done" } | { type: "error", message }
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { mensaje, tenantId, agentEmail, agentRole, historial = [], contexto = null } = req.body;

    if (!mensaje || typeof mensaje !== "string") {
      return res.status(400).json({ error: "Falta el campo 'mensaje'" });
    }

    const esSuperadmin = agentRole === "superadmin";

    // Verificar que el módulo agenteIA esté habilitado para este tenant
    // El superadmin puede operar en cualquier tenant sin restricción de módulos
    if (tenantId && !esSuperadmin) {
      const tenantRows = await sbQuery("tenants", `id=eq.${tenantId}&select=modulos`);
      const modulos = tenantRows[0]?.modulos;
      if (Array.isArray(modulos) && !modulos.includes("agenteIA")) {
        return res.status(403).json({ error: "El módulo Agente IA no está habilitado para esta cuenta." });
      }
    }

    // Construir contexto solo si no viene cacheado del cliente
    const ctx = contexto || await buildTenantContext(tenantId);

    const systemPrompt = [
      "Sos el asistente interno de una inmobiliaria argentina.",
      "Tu rol es ayudar a los agentes inmobiliarios en su trabajo diario.",
      "Respondés en español rioplatense, con tono profesional pero directo.",
      "Sos conciso: no das vueltas innecesarias ni repetís información.",
      "",
      "IMPORTANTE — SCOPE DE DATOS:",
      "El contexto que recibís corresponde EXCLUSIVAMENTE a la inmobiliaria en la que",
      "está logueado el agente. Nunca mezcles datos de otras cuentas ni inventes información.",
      "Si algo no figura en el contexto, decí que no tenés ese dato — no lo supongas.",
      "Nunca uses la palabra 'tenant' al hablar con el agente — usá 'inmobiliaria' o 'cuenta' según el contexto.",
      "",
      "LO QUE PODÉS HACER:",
      "- Responder preguntas sobre contratos, pagos, inquilinos, propietarios, propiedades,",
      "  tasaciones y recordatorios de la inmobiliaria usando el contexto provisto",
      "- Calcular totales, promedios, vencimientos y resúmenes a partir de los datos del contexto",
      "- Alertar sobre contratos por vencer, pagos morosos o pendientes, recordatorios del día",
      "- Ayudar a redactar mensajes o borradores para clientes",
      "- Responder preguntas generales sobre el mercado inmobiliario argentino",
      "- CREAR RECORDATORIOS en nombre del agente (ver instrucciones abajo)",
      "",
      "LO QUE NO PODÉS HACER:",
      "- Modificar contratos, pagos u otros datos — eso se hace desde los módulos de la app",
      "- Inventar datos que no estén en el contexto",
      "- Acceder a información de otros tenants",
      "",
      "── CREAR RECORDATORIOS ──",
      "Cuando el agente pide agendar algo (ej: 'agendame llamar a Juan mañana a las 15h',",
      "'recordame contactar a García el viernes', 'poneme un recordatorio para el lunes 9am'),",
      "DEBES responder ÚNICAMENTE con un bloque JSON con este formato exacto, sin texto adicional antes ni después:",
      "",
      "```json",
      "{",
      '  "accion": "crear_recordatorio",',
      '  "asunto": "Llamar a Juan",',
      '  "destino_nombre": "Juan",',
      '  "fecha_envio": "2026-06-12T15:00:00",',
      '  "mensaje": "Recordatorio para llamar a Juan"',
      "}",
      "```",
      "",
      "Reglas para el JSON:",
      "- 'accion' siempre es 'crear_recordatorio'",
      "- 'asunto': frase corta descriptiva (máx 60 caracteres)",
      "- 'destino_nombre': nombre de la persona a contactar (extraído del mensaje del agente)",
      "- 'fecha_envio': fecha y hora en formato ISO 'YYYY-MM-DDTHH:MM:00' en zona local Argentina (UTC-3).",
      `  La fecha de hoy es ${new Date().toISOString().split("T")[0]}.`,
      "  'mañana' = hoy + 1 día. 'el lunes' = próximo lunes. Si no especifica hora, usar 08:00.",
      "- 'mensaje': mensaje opcional para recordar el contexto (puede ser null)",
      "",
      "Si falta información crítica (como la fecha), preguntá antes de generar el JSON.",
      "Si el agente menciona una persona que aparece en el contexto (propietario, inquilino),",
      "intentá completar 'destino_nombre' con el nombre completo que figura en los datos.",
      "",
      `Agente logueado: ${agentEmail || "desconocido"}`,
      "",
      ctx,
    ].join("\n");

    // Historial: máx últimos 10 mensajes
    const mensajesApi = [
      ...historial.slice(-10),
      { role: "user", content: mensaje },
    ];

    // Configurar SSE
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    // Enviar contexto al cliente para que lo cachee
    res.write(`data: ${JSON.stringify({ type: "context", contexto: ctx })}\n\n`);

    // Streaming con Anthropic SDK
    const stream = await anthropic.messages.stream({
      model:      "claude-sonnet-4-5",
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   mensajesApi,
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ type: "delta", text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();

  } catch (err) {
    console.error("[chat] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error en el agente IA", detalle: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── ENDPOINT /api/generar-docx ────────────────────────────────
app.post("/api/generar-docx", upload.single("plantilla"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió el archivo .docx (campo: plantilla)" });
    }
    if (!req.body.datos) {
      return res.status(400).json({ error: "Falta el campo 'datos' (JSON string)" });
    }

    let datos;
    try {
      datos = JSON.parse(req.body.datos);
    } catch {
      return res.status(400).json({ error: "El campo 'datos' no es un JSON válido" });
    }

    const zip = new PizZip(req.file.buffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks:    true,
      nullGetter:    () => "",
    });
    doc.render(datos);
    const buf = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });

    const nombre = req.body.nombre
      ? req.body.nombre.replace(/[^a-zA-Z0-9_\-\.]/g, "_")
      : `documento_${Date.now()}.docx`;

    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.send(buf);

  } catch (err) {
    console.error("[generar-docx] Error:", err.message);
    if (err.properties && err.properties.errors) {
      const tagErrors = err.properties.errors.map(e => ({
        tag: e.properties?.id || "desconocido", mensaje: e.message,
      }));
      return res.status(422).json({ error: "Error en la plantilla .docx", tags_con_error: tagErrors });
    }
    res.status(500).json({ error: "Error interno al procesar el documento", detalle: err.message });
  }
});

// ── ENDPOINT /api/consumos/extraer-factura ─────────────────────
// Módulo "Consumos de Servicios" (personal, Alex). Recibe la foto/PDF de una
// factura + la fuente (edenor/naturgy/visa), le pide a la IA que devuelva
// SOLO un JSON con los campos de esa factura (ver prompts abajo — mismo
// texto que `prompts_extraccion_facturas.md`), y se lo devuelve al frontend
// ya parseado para precargar el formulario de confirmación. No guarda nada
// en Supabase acá — el insert en `serv_facturas` lo hace el frontend recién
// cuando Ale confirma, después de revisar/corregir los valores.
const PROMPTS_EXTRACCION_FACTURA = {
  edenor: `Sos un extractor de datos de facturas de electricidad de Edenor (Argentina).
Te paso la imagen o PDF de una factura. Devolvé ÚNICAMENTE un objeto JSON,
sin texto antes ni después, sin backticks, con esta forma exacta:

{
  "anio": <número, año del período facturado>,
  "mes": <número 1-12, mes del período facturado>,
  "total": <número, importe total a pagar>,
  "consumo_fijo": <número, cargo fijo del período (a veces llamado "cargo fijo" o "término fijo")>,
  "consumo_variable": <número, cargo por consumo/energía (a veces "término energía" o similar) — SIN incluir impuestos>,
  "kwh_consumidos": <número, cantidad de kWh facturados en el período>,
  "valor_kwh": <número, valor unitario del kWh si figura>,
  "impuestos": <número, suma de IVA + impuestos nacionales/provinciales>,
  "tasa_municipal": <número, tasa/alumbrado municipal si figura por separado>,
  "otros": <número, cualquier otro cargo que no encaje en los anteriores (mora, intereses, ajustes) — sumado>,
  "periodo_desde": <"YYYY-MM-DD", inicio del período facturado si figura>,
  "periodo_hasta": <"YYYY-MM-DD", fin del período facturado si figura>
}

Si un campo no aparece en la factura o no podés leerlo con confianza, poné null en ese campo — no inventes valores. No agregues campos extra.`,

  naturgy: `Sos un extractor de datos de facturas de gas de Naturgy (Argentina). Te paso
la imagen o PDF de una factura. Devolvé ÚNICAMENTE un objeto JSON, sin texto
antes ni después, sin backticks, con esta forma exacta:

{
  "anio": <número, año del período facturado>,
  "mes": <número 1-12, mes del período facturado>,
  "total": <número, importe total a pagar>,
  "consumo_fijo": <número, cargo fijo del período — null si la factura no lo desglosa por separado>,
  "consumo_variable": <número, cargo por consumo de gas — null si la factura no lo desglosa por separado>,
  "m3_consumidos": <número, metros cúbicos facturados en el período>,
  "impuestos": <número, suma de IVA + impuestos nacionales/provinciales>,
  "tasa_municipal": <número, tasa municipal si figura por separado>,
  "otros": <número, cargos adicionales — mora, carta documento, intereses, ajustes — sumado>,
  "periodo_desde": <"YYYY-MM-DD", inicio del período facturado si figura>,
  "periodo_hasta": <"YYYY-MM-DD", fin del período facturado si figura>
}

IMPORTANTE: la cantidad de personas por unidad NO está en la factura — ese dato lo carga Ale a mano en el formulario, no lo completes vos.

Si un campo no aparece en la factura o no podés leerlo con confianza, poné null en ese campo — no inventes valores. No agregues campos extra.`,

  visa: `Sos un extractor de datos de resúmenes de tarjeta Visa (Argentina), para
seguir el pago del alquiler/gastos en dólares. Te paso la imagen o PDF del
resumen. Devolvé ÚNICAMENTE un objeto JSON, sin texto antes ni después, sin
backticks, con esta forma exacta:

{
  "anio": <número, año del cierre>,
  "mes": <número 1-12, mes del cierre>,
  "total_pesos": <número, total del resumen en pesos argentinos>,
  "total_dolares": <número, total en dólares si figura algún consumo/cuota en esa moneda>,
  "cotizacion_aplicada": <número, tipo de cambio usado para convertir el consumo en dólares a pesos, si figura>,
  "fecha_cierre": <"YYYY-MM-DD", fecha de cierre del resumen>,
  "fecha_vencimiento": <"YYYY-MM-DD", fecha de vencimiento del pago>
}

Si un campo no aparece en el resumen o no podés leerlo con confianza, poné null en ese campo — no inventes valores. No agregues campos extra.`,
};

app.post("/api/consumos/extraer-factura", uploadFactura.single("factura"), async (req, res) => {
  try {
    const { fuente } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió el archivo (campo: factura)" });
    }
    const prompt = PROMPTS_EXTRACCION_FACTURA[fuente];
    if (!prompt) {
      return res.status(400).json({ error: `Fuente desconocida: '${fuente}'. Usar "edenor", "naturgy" o "visa".` });
    }

    const esPdf = req.file.mimetype === "application/pdf";
    const base64 = req.file.buffer.toString("base64");

    const bloqueArchivo = esPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: req.file.mimetype, data: base64 } };

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [
        { role: "user", content: [bloqueArchivo, { type: "text", text: prompt }] },
      ],
    });

    const textoResp = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
    const limpio = textoResp.replace(/```json|```/g, "").trim();

    let campos;
    try {
      campos = JSON.parse(limpio);
    } catch {
      return res.status(422).json({ error: "La IA no devolvió un JSON válido", respuesta_cruda: textoResp });
    }

    res.json({ campos });

  } catch (err) {
    console.error("[extraer-factura] Error:", err.message);
    res.status(500).json({ error: "Error al extraer datos de la factura", detalle: err.message });
  }
});

// ── ENDPOINT /api/recordatorios ───────────────────────────────
/**
 * POST /api/recordatorios
 *
 * Crea un recordatorio en tas_recordatorios desde el AgentePanel.
 * Body JSON:
 *   {
 *     tenantId:       string,
 *     agentEmail:     string,
 *     agentNombre:    string,
 *     agentTgId:      string | null,
 *     asunto:         string,
 *     mensaje:        string | null,
 *     fecha_envio:    string (ISO),
 *     destino_nombre: string,
 *     destino_email:  string | null,
 *     destino_tel:    string | null,
 *     modulo:         string,
 *   }
 */
app.post("/api/recordatorios", async (req, res) => {
  try {
    const {
      tenantId, agentEmail, agentNombre, agentRole, agentTgId,
      asunto, mensaje, fecha_envio,
      destino_nombre, destino_email, destino_tel,
    } = req.body;

    console.log(`[recordatorios] POST recibido — tenant=${tenantId} agent=${agentEmail} role=${agentRole} asunto="${asunto}"`);

    if (!tenantId)       return res.status(400).json({ error: "Falta tenantId" });
    if (!asunto)         return res.status(400).json({ error: "Falta asunto" });
    if (!fecha_envio)    return res.status(400).json({ error: "Falta fecha_envio" });
    if (!destino_nombre) return res.status(400).json({ error: "Falta destino_nombre" });

    const esSuperadmin = agentRole === "superadmin";

    // ── Validar que el agentEmail pertenece al tenantId declarado ─
    // El superadmin puede crear recordatorios en cualquier tenant sin validación.
    if (agentEmail && !esSuperadmin) {
      const agentRows = await sbQuery(
        "agents",
        `tenant_id=eq.${tenantId}&select=id,data&limit=50`
      );
      console.log(`[recordatorios] agentRows encontrados: ${agentRows.length}`);
      const perteneceAlTenant = agentRows.some(r => {
        try {
          const d = typeof r.data === "object" ? r.data : JSON.parse(r.data || "{}");
          return d?.email === agentEmail;
        } catch { return false; }
      });
      if (!perteneceAlTenant) {
        console.warn(`[recordatorios] Agente ${agentEmail} no pertenece al tenant ${tenantId} — rechazado`);
        return res.status(403).json({ error: "El agente no pertenece a esta cuenta." });
      }
      console.log(`[recordatorios] Agente ${agentEmail} validado OK`);
    } else if (esSuperadmin) {
      console.log(`[recordatorios] Superadmin ${agentEmail} — validación de tenant salteada`);
    }

    const payload = {
      tenant_id:             tenantId,
      agente_id:             agentEmail || null,
      agente_nombre:         agentNombre || agentEmail || null,
      propietario_nombre:    destino_nombre,
      propietario_email:     destino_email || null,
      propietario_telefono:  destino_tel   || null,
      asunto:                asunto,
      mensaje_personalizado: mensaje       || null,
      fecha_envio:           fecha_envio,
      estado:                "pendiente",
      canal:                 "email",
      // Nota: sin columna "modulo" — no existe en tas_recordatorios
    };

    console.log(`[recordatorios] Insertando payload:`, JSON.stringify(payload));

    const sbRes = await fetch(`${SB_URL}/rest/v1/tas_recordatorios`, {
      method:  "POST",
      headers: {
        "apikey":        SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!sbRes.ok) {
      const e = await sbRes.text();
      console.error(`[recordatorios] Supabase error ${sbRes.status}:`, e);
      return res.status(500).json({ error: "Error al guardar en Supabase", detalle: e });
    }

    const rows = await sbRes.json();
    const creado = Array.isArray(rows) ? rows[0] : rows;
    console.log(`[recordatorios] Creado id=${creado?.id} tenant=${tenantId} asunto="${asunto}"`);
    res.json({ ok: true, id: creado?.id });

  } catch (err) {
    console.error("[recordatorios] Error:", err.message);
    res.status(500).json({ error: "Error interno", detalle: err.message });
  }
});

// ── CRON: disparar recordatorios pendientes ───────────────────
// Cada 5 minutos busca recordatorios con fecha_envio <= ahora y estado=pendiente
// y envía notificación por email al agente (si RESEND_API_KEY está configurada).
// Marca el recordatorio como "enviado" al completarse.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL     = process.env.FROM_EMAIL     || "recordatorios@alvarez-inmobiliaria.com";

async function enviarEmailResend(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn("[cron] RESEND_API_KEY no configurada — email no enviado a:", to);
    return false;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    if (!r.ok) {
      const e = await r.text();
      console.error("[cron] Resend error:", e);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[cron] Resend exception:", e.message);
    return false;
  }
}

async function procesarRecordatoriosPendientes() {
  if (!SB_URL || !SB_KEY) return;
  try {
    const ahora = new Date().toISOString();
    // Buscar recordatorios pendientes cuya fecha_envio ya pasó
    const pendientes = await sbQuery(
      "tas_recordatorios",
      `estado=eq.pendiente&fecha_envio=lte.${encodeURIComponent(ahora)}&select=*&limit=50`
    );

    if (pendientes.length === 0) return;
    console.log(`[cron] ${pendientes.length} recordatorio(s) a disparar`);

    for (const rec of pendientes) {
      let enviado = false;

      // Enviar email al agente si tiene email
      const emailAgente = rec.agente_id || rec.agente_nombre;
      if (emailAgente && emailAgente.includes("@")) {
        const horaDisplay = rec.fecha_envio
          ? new Date(rec.fecha_envio).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
          : "";
        const htmlEmail = `
          <div style="font-family:sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#790202">🔔 Recordatorio: ${rec.asunto}</h2>
            <p><strong>Para:</strong> ${rec.propietario_nombre || "—"}</p>
            ${rec.propietario_telefono ? `<p><strong>Tel:</strong> ${rec.propietario_telefono}</p>` : ""}
            ${rec.propietario_email    ? `<p><strong>Email:</strong> ${rec.propietario_email}</p>` : ""}
            ${rec.mensaje_personalizado ? `<p><strong>Mensaje:</strong> ${rec.mensaje_personalizado}</p>` : ""}
            <p style="color:#888;font-size:12px">Programado para: ${horaDisplay}</p>
            ${rec.propietario_telefono
              ? `<a href="https://wa.me/54${rec.propietario_telefono.replace(/\D/g,"")}${rec.mensaje_personalizado ? "?text=" + encodeURIComponent(rec.mensaje_personalizado) : ""}"
                   style="display:inline-block;margin-top:12px;background:#25d366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold">
                   💬 Enviar por WhatsApp
                 </a>`
              : ""}
          </div>`;
        enviado = await enviarEmailResend(emailAgente, `🔔 Recordatorio: ${rec.asunto}`, htmlEmail);
      }

      // Marcar como enviado en Supabase
      try {
        await fetch(`${SB_URL}/rest/v1/tas_recordatorios?id=eq.${rec.id}`, {
          method:  "PATCH",
          headers: {
            "apikey":        SB_KEY,
            "Authorization": `Bearer ${SB_KEY}`,
            "Content-Type":  "application/json",
            "Prefer":        "return=minimal",
          },
          body: JSON.stringify({ estado: "enviado" }),
        });
        console.log(`[cron] Recordatorio id=${rec.id} marcado como enviado (email=${enviado})`);
      } catch (e) {
        console.error(`[cron] Error al marcar id=${rec.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[cron] Error general:", e.message);
  }
}

// Arrancar cron cada 5 minutos
setInterval(procesarRecordatoriosPendientes, 5 * 60 * 1000);
// También correr 30 segundos después del arranque (para no esperar 5 min al primer deploy)
setTimeout(procesarRecordatoriosPendientes, 30 * 1000);

// ── Health ────────────────────────────────────────────────────
const healthRes = () => ({ status: "ok", version: "2.5.5", ts: new Date().toISOString() });
app.get("/",           (req, res) => res.json(healthRes()));
app.get("/health",     (req, res) => res.json(healthRes()));
app.get("/api/health", (req, res) => res.json(healthRes()));

app.listen(PORT, () => {
  console.log(`\n✅ Backend SaaS Inmobiliaria v2.5.5 corriendo en http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/generar-docx`);
  console.log(`   POST http://localhost:${PORT}/api/chat`);
  console.log(`   POST http://localhost:${PORT}/api/consumos/extraer-factura`);
  console.log(`   POST http://localhost:${PORT}/api/recordatorios`);
  console.log(`   GET  http://localhost:${PORT}/api/health\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY no configurada — /api/chat no va a funcionar");
  if (!process.env.SUPABASE_URL)      console.warn("⚠️  SUPABASE_URL no configurada — contexto del agente estará vacío");
  if (!process.env.RESEND_API_KEY)    console.warn("⚠️  RESEND_API_KEY no configurada — cron enviará emails en modo silencioso");
});
