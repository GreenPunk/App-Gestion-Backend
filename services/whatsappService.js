// ─── whatsappService.js — llamadas a la WhatsApp Cloud API de Meta ─────────
// Variables de entorno necesarias en Render:
//   WHATSAPP_TOKEN            → token permanente del System User (Never expire)
//   WHATSAPP_PHONE_NUMBER_ID  → Phone Number ID (NO es el número en sí, es un
//                                id numérico que te da Meta en API Setup)
//   WHATSAPP_VERIFY_TOKEN     → string inventado por vos, se usa solo para el
//                                handshake de verificación del webhook

const GRAPH_VERSION = "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Falta la variable de entorno ${name}`);
  return val;
}

// Envía un mensaje de texto libre. Solo funciona si hay una conversación
// abierta (el contacto escribió en las últimas 24hs) — si no, Meta devuelve
// error y hay que usar sendTemplateMessage en su lugar.
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
  // data.messages[0].id → guardar como wa_message_id
  return data;
}

// Envía un mensaje de plantilla previamente aprobada por Meta — necesario
// para "abrir" una conversación nueva o retomar una cerrada (fuera de las
// 24hs). `components` sigue el formato de Meta si la plantilla tiene
// variables ({{1}}, {{2}}, etc.); pasar [] si no tiene.
async function sendTemplateMessage(to, templateName, languageCode = "es_AR", components = []) {
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
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`WhatsApp API error: ${msg}`);
  }
  return data;
}

module.exports = { sendTextMessage, sendTemplateMessage };
