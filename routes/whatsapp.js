// ─── routes/whatsapp.js ─────────────────────────────────────────────────────
// Monta esto en server.js con: app.use("/whatsapp", require("./routes/whatsapp"));
//
// Variables de entorno adicionales (sumar en Render, junto a las de
// whatsappService.js):
//   SUPABASE_URL           → misma URL que SB_URL en el frontend
//   SUPABASE_SERVICE_KEY   → service_role key de Supabase (Project Settings →
//                             API). OJO: es distinta de la publishable/anon
//                             key que usa el frontend. Esta SÍ puede saltarse
//                             RLS y NUNCA debe ir en código de frontend — acá
//                             es seguro porque el backend no es público.

const express = require("express");
const router = express.Router();
const { sendTextMessage } = require("../services/whatsappService");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Helper mínimo para hablar con la REST API de Supabase desde el backend,
// mismo estilo que sbFetch del frontend pero con la service key.
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) { const e = await res.text(); throw new Error(e); }
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

// Busca (o crea) la conversación para un tenant+teléfono, y de paso intenta
// linkearla a un lead existente por teléfono si todavía no tiene lead_id.
async function getOrCreateConversacion(tenantId, telefono, nombreContacto) {
  const existentes = await sb(
    `emp_whatsapp_conversaciones?tenant_id=eq.${tenantId}&telefono=eq.${telefono}&select=*`
  );
  if (existentes[0]) return existentes[0];

  // Intento de match con un lead ya cargado, comparando los últimos 10
  // dígitos del teléfono guardado en emp_leads (sin importar cómo esté
  // formateado ahí: con o sin 54/9/0/15).
  const ultimos10 = telefono.slice(-10);
  const leadsMatch = await sb(
    `emp_leads?tenant_id=eq.${tenantId}&telefono=ilike.*${ultimos10}&select=id&limit=1`
  ).catch(() => []);

  const nueva = await sb("emp_whatsapp_conversaciones", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      telefono,
      nombre_contacto: nombreContacto || null,
      lead_id: leadsMatch[0]?.id || null,
    }),
  });
  return nueva[0];
}

async function actualizarUltimoMensaje(conversacionId, texto, incrementarNoLeidos) {
  const conv = await sb(`emp_whatsapp_conversaciones?id=eq.${conversacionId}&select=no_leidos`);
  const noLeidos = incrementarNoLeidos ? (conv[0]?.no_leidos || 0) + 1 : conv[0]?.no_leidos || 0;
  return sb(`emp_whatsapp_conversaciones?id=eq.${conversacionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      ultimo_mensaje: texto,
      ultimo_mensaje_fecha: new Date().toISOString(),
      no_leidos: noLeidos,
    }),
  });
}

// ── GET /whatsapp/webhook — handshake de verificación (una sola vez, al
// configurar el Callback URL en Meta App Dashboard → WhatsApp → Configuration)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── POST /whatsapp/webhook — acá llegan los mensajes entrantes y los
// cambios de estado de los que mandamos nosotros (entregado/leído/fallido).
// IMPORTANTE: hay que responder 200 rápido, si no Meta reintenta durante
// días — por eso el trabajo pesado no debería bloquear la respuesta en un
// caso de mucho volumen, pero para este volumen (inmobiliaria chica) alcanza
// con await directo.
router.post("/webhook", async (req, res) => {
  res.sendStatus(200); // confirmar recepción primero, procesar después

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    // Necesitamos saber a qué tenant pertenece este número — por ahora
    // asumimos un solo número de WhatsApp por tenant y lo resolvemos por
    // phone_number_id contra una tabla de config (ver nota abajo).
    const phoneNumberId = value.metadata?.phone_number_id;
    const tenantId = await resolverTenantPorPhoneNumberId(phoneNumberId);
    if (!tenantId) {
      console.warn("Webhook de WhatsApp: no se encontró tenant para phone_number_id", phoneNumberId);
      return;
    }

    // Mensajes entrantes
    if (value.messages) {
      for (const msg of value.messages) {
        const telefono = msg.from; // ya viene en formato wa_id, ej "5493415551234"
        const nombreContacto = value.contacts?.[0]?.profile?.name || null;
        const texto = msg.text?.body || `[${msg.type}]`; // por si es imagen/audio/etc, sin parsear el contenido todavía

        const conv = await getOrCreateConversacion(tenantId, telefono, nombreContacto);
        await sb("emp_whatsapp_mensajes", {
          method: "POST",
          body: JSON.stringify({
            conversacion_id: conv.id,
            direccion: "entrante",
            cuerpo: texto,
            wa_message_id: msg.id,
          }),
        });
        await actualizarUltimoMensaje(conv.id, texto, true);
      }
    }

    // Actualizaciones de estado de mensajes que mandamos nosotros
    if (value.statuses) {
      for (const st of value.statuses) {
        await sb(`emp_whatsapp_mensajes?wa_message_id=eq.${st.id}`, {
          method: "PATCH",
          body: JSON.stringify({ estado: st.status }),
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error("Error procesando webhook de WhatsApp:", e.message);
  }
});

// Resuelve el tenant a partir del phone_number_id de Meta. Guardar esta
// relación en la tabla `tenants` (columna nueva `whatsapp_phone_number_id`)
// o en `app_config` — ajustar según cuál prefieras. Placeholder simple acá:
async function resolverTenantPorPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const rows = await sb(`tenants?whatsapp_phone_number_id=eq.${phoneNumberId}&select=id`).catch(() => []);
  return rows[0]?.id || null;
}

// ── POST /whatsapp/send — usado por el frontend (reemplaza el window.open
// de wa.me en enviarContacto). Body esperado:
//   { tenantId, telefono, mensaje, leadId, agenteId }
// `telefono` tiene que venir ya en formato wa_id (549 + 10 dígitos) — el
// frontend ya lo arma así con validarTelefonoAR().
router.post("/send", async (req, res) => {
  const { tenantId, telefono, mensaje, leadId, agenteId } = req.body;
  if (!tenantId || !telefono || !mensaje) {
    return res.status(400).json({ error: "Faltan tenantId, telefono o mensaje" });
  }

  try {
    const result = await sendTextMessage(telefono, mensaje);
    const waMessageId = result?.messages?.[0]?.id || null;

    const conv = await getOrCreateConversacion(tenantId, telefono, null);
    // Si la conversación no tenía lead_id todavía y este envío sí lo trae
    // (se mandó desde la ficha de un lead conocido), lo linkeamos ahora.
    if (leadId && !conv.lead_id) {
      await sb(`emp_whatsapp_conversaciones?id=eq.${conv.id}`, {
        method: "PATCH",
        body: JSON.stringify({ lead_id: leadId }),
      }).catch(() => {});
    }

    await sb("emp_whatsapp_mensajes", {
      method: "POST",
      body: JSON.stringify({
        conversacion_id: conv.id,
        direccion: "saliente",
        cuerpo: mensaje,
        wa_message_id: waMessageId,
        estado: "enviado",
        agente_id: agenteId || null,
      }),
    });
    await actualizarUltimoMensaje(conv.id, mensaje, false);

    res.json({ ok: true, waMessageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
