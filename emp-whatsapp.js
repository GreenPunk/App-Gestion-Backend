/**
 * ─────────────────────────────────────────────────────────────
 *  emp-whatsapp.js — Módulo WhatsApp Cloud API
 * ─────────────────────────────────────────────────────────────
 * Mismo patrón que emp-leads.js: una función factory que recibe las
 * credenciales de Supabase ya armadas en server.js y devuelve un router
 * de Express para montar ahí.
 *
 * Variables de entorno que usa este módulo (sumar en Render):
 *   WHATSAPP_TOKEN            → token permanente del System User de Meta
 *   WHATSAPP_PHONE_NUMBER_ID  → Phone Number ID (Meta App Dashboard → WhatsApp → API Setup)
 *   WHATSAPP_VERIFY_TOKEN     → string inventado por vos, para el handshake del webhook
 *
 * Tablas nuevas en Supabase (ver migracion_whatsapp.sql):
 *   emp_whatsapp_conversaciones
 *   emp_whatsapp_mensajes
 *   tenants.whatsapp_phone_number_id  (columna nueva, para resolver el tenant
 *                                       desde el webhook de Meta)
 * ─────────────────────────────────────────────────────────────
 */

const express = require("express");

const GRAPH_VERSION = "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

module.exports = function crearModuloWhatsapp({ SB_URL, SB_KEY, sbQuery }) {
  const router = express.Router();

  // ── Escritura contra Supabase (mismo estilo que /api/recordatorios en
  // server.js: fetch directo con SB_KEY — las tablas de WhatsApp tienen
  // policy anon_full_access, así que no hace falta la service key acá).
  async function sbWrite(table, method, body, filtro = "") {
    const res = await fetch(`${SB_URL}/rest/v1/${table}${filtro}`, {
      method,
      headers: {
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.text();
      throw new Error(`Supabase ${method} ${table} error ${res.status}: ${e}`);
    }
    const t = await res.text();
    return t ? JSON.parse(t) : [];
  }

  // ── Llamadas a la Cloud API de Meta ─────────────────────────
  function requireEnv(name) {
    const val = process.env[name];
    if (!val) throw new Error(`Falta la variable de entorno ${name}`);
    return val;
  }

  async function sendTextMessage(to, body) {
    const token = requireEnv("WHATSAPP_TOKEN");
    const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");

    const res = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      throw new Error(`WhatsApp API error: ${msg}`);
    }
    return data;
  }

  // ── Helpers de conversación ──────────────────────────────────
  async function getOrCreateConversacion(tenantId, telefono, nombreContacto) {
    const existentes = await sbQuery(
      "emp_whatsapp_conversaciones",
      `tenant_id=eq.${tenantId}&telefono=eq.${telefono}&select=*`
    );
    if (existentes[0]) return existentes[0];

    const ultimos10 = telefono.slice(-10);
    const leadsMatch = await sbQuery(
      "emp_leads",
      `tenant_id=eq.${tenantId}&telefono=ilike.*${ultimos10}&select=id&limit=1`
    ).catch(() => []);

    const nueva = await sbWrite("emp_whatsapp_conversaciones", "POST", {
      tenant_id: tenantId,
      telefono,
      nombre_contacto: nombreContacto || null,
      lead_id: leadsMatch[0]?.id || null,
    });
    return nueva[0];
  }

  async function actualizarUltimoMensaje(conversacionId, texto, direccion, incrementarNoLeidos) {
    const conv = await sbQuery("emp_whatsapp_conversaciones", `id=eq.${conversacionId}&select=no_leidos`);
    const noLeidos = incrementarNoLeidos ? (conv[0]?.no_leidos || 0) + 1 : conv[0]?.no_leidos || 0;
    return sbWrite("emp_whatsapp_conversaciones", "PATCH", {
      ultimo_mensaje: texto,
      ultimo_mensaje_direccion: direccion,
      ultimo_mensaje_fecha: new Date().toISOString(),
      no_leidos: noLeidos,
    }, `?id=eq.${conversacionId}`);
  }

  async function resolverTenantPorPhoneNumberId(phoneNumberId) {
    if (!phoneNumberId) return null;
    const rows = await sbQuery("tenants", `whatsapp_phone_number_id=eq.${phoneNumberId}&select=id`).catch(() => []);
    return rows[0]?.id || null;
  }

  // ── GET /api/whatsapp/webhook — handshake de verificación ───
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // ── POST /api/whatsapp/webhook — mensajes entrantes y estados ─
  router.post("/webhook", async (req, res) => {
    res.sendStatus(200); // confirmar recepción primero, procesar después

    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      if (!value) return;

      const phoneNumberId = value.metadata?.phone_number_id;
      const tenantId = await resolverTenantPorPhoneNumberId(phoneNumberId);
      if (!tenantId) {
        console.warn("[whatsapp] Webhook: no se encontró tenant para phone_number_id", phoneNumberId);
        return;
      }

      if (value.messages) {
        for (const msg of value.messages) {
          const telefono = msg.from;
          const nombreContacto = value.contacts?.[0]?.profile?.name || null;
          const texto = msg.text?.body || `[${msg.type}]`;

          const conv = await getOrCreateConversacion(tenantId, telefono, nombreContacto);
          await sbWrite("emp_whatsapp_mensajes", "POST", {
            conversacion_id: conv.id,
            direccion: "entrante",
            cuerpo: texto,
            wa_message_id: msg.id,
          });
          await actualizarUltimoMensaje(conv.id, texto, "entrante", true);
          console.log(`[whatsapp] Mensaje entrante de ${telefono} (tenant ${tenantId}): "${texto}"`);
        }
      }

      if (value.statuses) {
        for (const st of value.statuses) {
          await sbWrite("emp_whatsapp_mensajes", "PATCH", { estado: st.status }, `?wa_message_id=eq.${st.id}`).catch(() => {});
        }
      }
    } catch (e) {
      console.error("[whatsapp] Error procesando webhook:", e.message);
    }
  });

  // ── POST /api/whatsapp/send — usado por el módulo de leads ───
  router.post("/send", async (req, res) => {
    const { tenantId, telefono, mensaje, leadId, agenteId } = req.body;
    if (!tenantId || !telefono || !mensaje) {
      return res.status(400).json({ error: "Faltan tenantId, telefono o mensaje" });
    }

    try {
      const result = await sendTextMessage(telefono, mensaje);
      const waMessageId = result?.messages?.[0]?.id || null;

      const conv = await getOrCreateConversacion(tenantId, telefono, null);
      if (leadId && !conv.lead_id) {
        await sbWrite("emp_whatsapp_conversaciones", "PATCH", { lead_id: leadId }, `?id=eq.${conv.id}`).catch(() => {});
      }

      await sbWrite("emp_whatsapp_mensajes", "POST", {
        conversacion_id: conv.id,
        direccion: "saliente",
        cuerpo: mensaje,
        wa_message_id: waMessageId,
        estado: "enviado",
        agente_id: agenteId || null,
      });
      await actualizarUltimoMensaje(conv.id, mensaje, "saliente", false);

      console.log(`[whatsapp] Mensaje enviado a ${telefono} (tenant ${tenantId})`);
      res.json({ ok: true, waMessageId });
    } catch (e) {
      console.error("[whatsapp] Error en /send:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { router };
};
