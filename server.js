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
async function buildTenantContext(tenantId) {
  if (!tenantId) return "Sin tenant seleccionado — no hay datos disponibles.";

  const hoy     = new Date();
  const hoyStr  = hoy.toISOString().split("T")[0];
  const en30    = new Date(hoy);
  en30.setDate(en30.getDate() + 30);
  const en30Str = en30.toISOString().split("T")[0];

  const [contratos, pagos, propietarios, recordatorios] = await Promise.all([
    sbQuery("alq_contratos",   `tenant_id=eq.${tenantId}&select=id,data&order=id.asc&limit=100`),
    sbQuery("alq_pagos",       `tenant_id=eq.${tenantId}&select=id,data&order=id.desc&limit=200`),
    sbQuery("alq_propietarios",`tenant_id=eq.${tenantId}&select=id,data&limit=50`),
    sbQuery("tas_recordatorios",`tenant_id=eq.${tenantId}&estado=eq.pendiente&select=*&order=fecha.asc&limit=50`),
  ]);

  const parseData = (r) => {
    try { return typeof r.data === "object" ? r.data : JSON.parse(r.data); }
    catch { return null; }
  };

  const contratosData = contratos.map(parseData).filter(Boolean);
  const porVencer     = contratosData.filter(c =>
    c.fecha_fin && c.estado !== "finalizado" && c.fecha_fin >= hoyStr && c.fecha_fin <= en30Str
  );
  const pagosData  = pagos.map(parseData).filter(p => p && p.estado === "pendiente");
  const propNames  = propietarios.map(r => {
    const d = parseData(r);
    return d ? (d.nombre || d.name || "Sin nombre") : null;
  }).filter(Boolean);
  const recHoy = recordatorios.filter(r => r.fecha === hoyStr);

  const lines = [
    `=== CONTEXTO DEL TENANT (tenant_id: ${tenantId}) ===`,
    `Fecha de hoy: ${hoyStr}`,
    "",
    `CONTRATOS ACTIVOS: ${contratosData.filter(c => c.estado === "activo").length}`,
    `CONTRATOS POR VENCER EN 30 DÍAS: ${porVencer.length}`,
    porVencer.length > 0
      ? porVencer.slice(0, 5).map(c =>
          `  - ${c.inquilino || c.inquilino_nombre || "?"}: vence ${c.fecha_fin} · $${c.monto_actual || c.monto || "?"}`
        ).join("\n")
      : "  Ninguno",
    "",
    `PAGOS PENDIENTES: ${pagosData.length}`,
    pagosData.length > 0
      ? pagosData.slice(0, 5).map(p =>
          `  - ${p.inquilino || p.descripcion || "?"}: $${p.monto || "?"} · vto ${p.fecha_vencimiento || p.fecha || "?"}`
        ).join("\n")
      : "  Ninguno",
    "",
    `PROPIETARIOS REGISTRADOS: ${propNames.length}`,
    propNames.length > 0
      ? `  ${propNames.slice(0, 10).join(", ")}${propNames.length > 10 ? ` y ${propNames.length - 10} más` : ""}`
      : "  Ninguno",
    "",
    `RECORDATORIOS PARA HOY: ${recHoy.length}`,
    recHoy.length > 0
      ? recHoy.map(r => `  - ${r.hora || ""} ${r.mensaje}`).join("\n")
      : "  Ninguno",
    "=== FIN CONTEXTO ===",
  ];

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
      "LO QUE PODÉS HACER:",
      "- Responder preguntas sobre contratos, pagos, propietarios, recordatorios y tasaciones del tenant",
      "- Generar resúmenes y alertas sobre vencimientos o pagos pendientes",
      "- Ayudar a redactar mensajes o borradores para clientes",
      "- Responder preguntas generales sobre el mercado inmobiliario argentino",
      "",
      "LO QUE NO PODÉS HACER:",
      "- Modificar datos — eso se hace desde los módulos de la app",
      "- Si el usuario pide crear, editar o borrar algo, explicale que debe hacerlo desde el módulo correspondiente",
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
const healthRes = () => ({ status: "ok", version: "2.0.0", ts: new Date().toISOString() });
app.get("/",           (req, res) => res.json(healthRes()));
app.get("/health",     (req, res) => res.json(healthRes()));
app.get("/api/health", (req, res) => res.json(healthRes()));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Backend SaaS Inmobiliaria corriendo en http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/generar-docx`);
  console.log(`   POST http://localhost:${PORT}/api/chat`);
  console.log(`   GET  http://localhost:${PORT}/api/health\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY no configurada — /api/chat no va a funcionar");
  if (!process.env.SUPABASE_URL)      console.warn("⚠️  SUPABASE_URL no configurada — contexto del agente estará vacío");
});
