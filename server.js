/**
 * ─────────────────────────────────────────────────────────────
 *  BACKEND — SaaS Gestión Inmobiliaria
 *  Node.js + Express + docxtemplater + pizzip + Anthropic
 * ─────────────────────────────────────────────────────────────
 *
 *  ENDPOINTS:
 *    POST /api/generar-docx   → recibe plantilla + datos, devuelve .docx relleno
 *    POST /api/chat           → chat IA con contexto del tenant (streaming SSE)
 *    GET  /api/health         → estado del servidor
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
  methods: ["GET", "POST", "OPTIONS"],
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
    const { mensaje, tenantId, agentEmail, historial = [], contexto = null } = req.body;

    if (!mensaje || typeof mensaje !== "string") {
      return res.status(400).json({ error: "Falta el campo 'mensaje'" });
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
      "",
      "LO QUE NO PODÉS HACER:",
      "- Modificar datos — eso se hace desde los módulos de la app",
      "- Inventar datos que no estén en el contexto",
      "- Acceder a información de otros tenants",
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
      model:      "claude-sonnet-4-20250514",
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

// ── Health ────────────────────────────────────────────────────
const healthRes = () => ({ status: "ok", version: "2.3.0", ts: new Date().toISOString() });
app.get("/",           (req, res) => res.json(healthRes()));
app.get("/health",     (req, res) => res.json(healthRes()));
app.get("/api/health", (req, res) => res.json(healthRes()));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Backend SaaS Inmobiliaria v2.3.0 corriendo en http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/generar-docx`);
  console.log(`   POST http://localhost:${PORT}/api/chat`);
  console.log(`   GET  http://localhost:${PORT}/api/health\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY no configurada — /api/chat no va a funcionar");
  if (!process.env.SUPABASE_URL)      console.warn("⚠️  SUPABASE_URL no configurada — contexto del agente estará vacío");
});
