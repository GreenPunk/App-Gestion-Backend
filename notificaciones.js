/**
 * ─────────────────────────────────────────────────────────────
 *  notificaciones.js — Avisos al celular (Telegram + ntfy)
 * ─────────────────────────────────────────────────────────────
 * Dispara un aviso a Telegram y/o a ntfy cuando llega un WhatsApp
 * nuevo o un mail nuevo a la casilla configurada. Los dos canales
 * son independientes entre sí y opcionales: si faltan las variables
 * de entorno de uno, ese canal se salta en silencio (con un log) y
 * el otro sigue funcionando igual.
 *
 * IMPORTANTE: esta función nunca tira una excepción hacia quien la
 * llama. Un aviso que falla (Telegram caído, topic de ntfy mal
 * escrito, etc.) se loguea acá adentro y no debe cortar el
 * procesamiento del webhook de WhatsApp ni del polling de mail.
 *
 * Variables de entorno (agregar en Render → Environment):
 *   TELEGRAM_BOT_TOKEN → token del bot, lo da @BotFather en Telegram
 *   TELEGRAM_CHAT_ID   → chat_id de destino (tu chat privado con el bot).
 *                         Se obtiene mandándole cualquier mensaje al bot y
 *                         mirando la respuesta de:
 *                         https://api.telegram.org/bot<TOKEN>/getUpdates
 *   NTFY_TOPIC         → nombre del topic de ntfy (inventá algo largo y
 *                         difícil de adivinar, ej. "alvarez-avisos-7f2k9d",
 *                         porque cualquiera que sepa el nombre del topic
 *                         puede suscribirse y ver los avisos)
 *   NTFY_SERVER        → opcional, default "https://ntfy.sh" (servidor
 *                         público). Si en algún momento se monta un ntfy
 *                         propio en Render, va acá.
 * ─────────────────────────────────────────────────────────────
 */

async function notificarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
    });
    if (!res.ok) {
      const e = await res.text();
      console.error("[notificaciones] Telegram respondió error:", res.status, e);
    }
  } catch (e) {
    console.error("[notificaciones] Error mandando a Telegram:", e.message);
  }
}

async function notificarNtfy(texto, titulo) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";

  try {
    const res = await fetch(`${server}/${topic}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...(titulo ? { Title: titulo } : {}),
      },
      body: texto,
    });
    if (!res.ok) {
      const e = await res.text();
      console.error("[notificaciones] ntfy respondió error:", res.status, e);
    }
  } catch (e) {
    console.error("[notificaciones] Error mandando a ntfy:", e.message);
  }
}

// Punto único de entrada para el resto del backend. Manda por los dos
// canales en paralelo (Promise.allSettled: si uno falla, no afecta al
// otro) y nunca propaga el error hacia arriba.
async function notificar(texto, titulo = null) {
  await Promise.allSettled([
    notificarTelegram(titulo ? `${titulo}\n${texto}` : texto),
    notificarNtfy(texto, titulo),
  ]);
}

module.exports = { notificar, notificarTelegram, notificarNtfy };
