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
 *   WHATSAPP_WABA_ID          → WhatsApp Business Account ID (Meta Business Manager →
 *                                configuración de WABA — distinto del PHONE_NUMBER_ID de
 *                                arriba). Hace falta solo para WA-MEJ-04 (traer plantillas).
 *
 * Tablas en Supabase (confirmado 2026-08-22 vía Supabase MCP — el esquema ya
 * tiene TODO lo necesario para plantillas y envío masivo, así que este
 * archivo escribe directo sobre esas columnas, sin migración pendiente):
 *   emp_whatsapp_conversaciones (+ ultimo_entrante_fecha, para la ventana de 24hs;
 *                                  + oculto, agregada 2026-08-23 para WA-MEJ-10 —
 *                                  soft-delete de un chat del inbox, se resetea
 *                                  a false solo si el contacto vuelve a escribir)
 *   emp_whatsapp_mensajes (+ tipo: texto|template|media, template_name,
 *                            media_url/media_id/media_tipo/media_nombre;
 *                            + oculto, agregada 2026-08-23 para WA-MEJ-13 —
 *                            "ocultar de mi vista" un mensaje puntual, no
 *                            borra nada del lado de WhatsApp/Meta)
 *   emp_whatsapp_envios_masivos (usada desde 2026-08-23 por
 *                                 POST /send-template-masivo, WA-MEJ-11/12)
 *   tenants.whatsapp_phone_number_id  (columna nueva, para resolver el tenant
 *                                       desde el webhook de Meta)
 * ─────────────────────────────────────────────────────────────
 */

const express = require("express");

const GRAPH_VERSION = "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Cache en memoria de las plantillas aprobadas — Meta no espera que se
// consulte esto en cada tecla que escribe el agente, y el listado cambia
// poco (solo cuando se aprueba/rechaza algo en Meta Business). 5 minutos
// alcanza para que el selector del panel se sienta actualizado sin pegarle
// a la Graph API de más. Se invalida sola por tiempo, no hace falta lógica
// de invalidación manual.
const PLANTILLAS_CACHE_MS = 5 * 60 * 1000;
let plantillasCache = { data: null, ts: 0 };

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

  // ── Modo prueba (sin credenciales de Meta todavía) ───────────
  // Mientras no estén cargadas WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID en
  // Render, no tiene sentido intentar pegarle a la Graph API (va a fallar
  // siempre). En vez de devolver error, se simula el envío: se genera un
  // id falso y se guarda todo en Supabase igual que si hubiera salido, así
  // se puede probar el resto de la interfaz (bitácora, badges, inbox) sin
  // depender de tener el token real todavía. El día que se carguen esas
  // variables en Render, esto deja de activarse solo — no hace falta tocar
  // nada más acá.
  function credencialesMetaConfiguradas() {
    return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  }

  async function sendTextMessage(to, body) {
    if (!credencialesMetaConfiguradas()) {
      console.warn("[whatsapp] Modo prueba: WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID no configurados todavía — se simula el envío, no se llama a Meta.");
      return {
        messaging_product: "whatsapp",
        messages: [{ id: `SIMULADO-${Date.now()}` }],
        __simulado: true,
      };
    }

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

  // ── WA-MEJ-04: plantillas aprobadas por Meta ──────────────────
  // Mismo criterio de "modo prueba" que sendTextMessage: si falta
  // WHATSAPP_WABA_ID (además de TOKEN/PHONE_NUMBER_ID), no tiene sentido
  // pegarle a Meta — se sirve un set fijo de plantillas de ejemplo para
  // poder construir y probar el selector del panel ya mismo. El día que
  // se cargue WHATSAPP_WABA_ID en Render, esto pasa solo a traer las
  // reales — no hace falta tocar código.
  function credencialesPlantillasConfiguradas() {
    return credencialesMetaConfiguradas() && !!process.env.WHATSAPP_WABA_ID;
  }

  function plantillasSimuladas() {
    return [
      {
        name: "bienvenida_lead_frio",
        language: "es_AR",
        category: "MARKETING",
        header: null,
        body: { texto: "Hola {{1}}! Vi que consultaste por {{2}}. Te comparto la info — cualquier duda, escribime por acá.", variables: 2 },
        footer: "Inmobiliaria Álvarez",
        botones: [],
        __simulado: true,
      },
      {
        name: "info_emprendimiento_folleto",
        language: "es_AR",
        category: "MARKETING",
        header: { formato: "IMAGE", texto: null, mediaHandle: "SIMULADO-MEDIA-HANDLE" },
        body: { texto: "Hola {{1}}! Te adjunto el folleto de {{2}} con precios y financiación vigente.", variables: 2 },
        footer: null,
        botones: [],
        __simulado: true,
      },
      {
        name: "recordatorio_visita",
        language: "es_AR",
        category: "UTILITY",
        header: { formato: "TEXT", texto: "Recordatorio de visita", mediaHandle: null },
        body: { texto: "Hola {{1}}, te confirmamos la visita para el {{2}} a las {{3}}. Cualquier cambio avisanos.", variables: 3 },
        footer: null,
        botones: [],
        __simulado: true,
      },
    ];
  }

  // Convierte el formato crudo de la Graph API de Meta (array de
  // `components` con type HEADER/BODY/FOOTER/BUTTONS) a una forma simple
  // que el frontend puede usar directo para armar el selector y los
  // inputs de variables, sin tener que conocer la estructura de Meta.
  function normalizarPlantilla(raw) {
    const comps = raw.components || [];
    const headerComp = comps.find(c => c.type === "HEADER");
    const bodyComp = comps.find(c => c.type === "BODY") || { text: "" };
    const footerComp = comps.find(c => c.type === "FOOTER");
    const botonesComp = comps.find(c => c.type === "BUTTONS");

    let header = null;
    if (headerComp) {
      if (headerComp.format === "TEXT") {
        header = { formato: "TEXT", texto: headerComp.text || "", mediaHandle: null };
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(headerComp.format)) {
        // El handle que Meta guarda en el `example` de la plantilla es el
        // mismo archivo que se subió y quedó aprobado junto con el texto —
        // por eso alcanza con esto para mandar el header, sin pedirle a
        // el agente que adjunte nada de nuevo cada vez que envía.
        const handle = headerComp.example?.header_handle?.[0] || null;
        header = { formato: headerComp.format, texto: null, mediaHandle: handle };
      }
    }

    const textoBody = bodyComp.text || "";
    const variablesEnBody = new Set((textoBody.match(/\{\{\d+\}\}/g) || []));

    return {
      name: raw.name,
      language: raw.language,
      category: raw.category,
      status: raw.status,
      header,
      body: { texto: textoBody, variables: variablesEnBody.size },
      footer: footerComp?.text || null,
      botones: (botonesComp?.buttons || []).map(b => ({ tipo: b.type, texto: b.text || null })),
    };
  }

  async function fetchPlantillasDeTodasLasPaginas(url, token) {
    let plantillas = [];
    let next = url;
    let paginas = 0;
    while (next && paginas < 10) { // tope de seguridad — 10 páginas (~2000 plantillas) más que de sobra
      const res = await fetch(next, { headers: { "Authorization": `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error?.message || JSON.stringify(data);
        throw new Error(`WhatsApp API error (plantillas): ${msg}`);
      }
      plantillas = plantillas.concat(data.data || []);
      next = data.paging?.next || null;
      paginas++;
    }
    return plantillas;
  }

  // Trae las plantillas APPROVED de Meta (con cache de 5 min) o, si todavía
  // no hay WABA_ID/token cargados, devuelve el set simulado — así el mismo
  // llamador (la ruta GET /templates y también POST /send-template, que
  // necesita encontrar la definición de la plantilla elegida) funciona
  // igual en los dos modos sin lógica duplicada.
  async function obtenerPlantillasAprobadas() {
    if (!credencialesPlantillasConfiguradas()) {
      return { plantillas: plantillasSimuladas(), simulado: true };
    }
    const ahora = Date.now();
    if (plantillasCache.data && (ahora - plantillasCache.ts) < PLANTILLAS_CACHE_MS) {
      return { plantillas: plantillasCache.data, simulado: false };
    }
    const token = requireEnv("WHATSAPP_TOKEN");
    const wabaId = requireEnv("WHATSAPP_WABA_ID");
    const url = `${GRAPH_URL}/${wabaId}/message_templates?fields=name,language,status,category,components&limit=250`;
    const crudas = await fetchPlantillasDeTodasLasPaginas(url, token);
    const aprobadas = crudas.filter(t => t.status === "APPROVED").map(normalizarPlantilla);
    plantillasCache = { data: aprobadas, ts: ahora };
    return { plantillas: aprobadas, simulado: false };
  }

  // ── Envío de un mensaje de plantilla ───────────────────────────
  // `componentesDeEnvio` ya viene armado (header con media si corresponde,
  // body con las variables completadas) — ver la ruta /send-template.
  async function sendTemplateMessage(to, templateName, languageCode, componentesDeEnvio) {
    if (!credencialesMetaConfiguradas()) {
      console.warn("[whatsapp] Modo prueba: se simula el envío de la plantilla, no se llama a Meta.");
      return {
        messaging_product: "whatsapp",
        messages: [{ id: `SIMULADO-${Date.now()}` }],
        __simulado: true,
      };
    }

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
          components: componentesDeEnvio,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || JSON.stringify(data);
      throw new Error(`WhatsApp API error (plantilla): ${msg}`);
    }
    return data;
  }

  // Arma el array `components` que espera Meta a partir de la plantilla ya
  // normalizada + las variables que completó el agente en el panel. El
  // header de media (si la plantilla tiene uno) sale del propio
  // `mediaHandle` que ya trajo la plantilla aprobada — nunca de un archivo
  // que suba el agente en el momento.
  function armarComponentesEnvio(plantilla, variables) {
    const componentes = [];
    if (plantilla.header?.mediaHandle) {
      const tipo = plantilla.header.formato.toLowerCase(); // image | video | document
      componentes.push({
        type: "header",
        parameters: [{ type: tipo, [tipo]: { id: plantilla.header.mediaHandle } }],
      });
    }
    if (plantilla.body.variables > 0) {
      componentes.push({
        type: "body",
        parameters: (variables || []).map(v => ({ type: "text", text: String(v ?? "") })),
      });
    }
    return componentes;
  }

  // Reemplaza {{1}}, {{2}}... del body por las variables completadas, para
  // guardar un preview legible en `cuerpo` (bitácora del lead, inbox) en
  // vez de guardar el texto crudo de Meta con los placeholders sin llenar.
  function renderizarPreviewPlantilla(plantilla, variables) {
    let texto = plantilla.body.texto;
    (variables || []).forEach((v, i) => {
      texto = texto.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, "g"), v || `{{${i + 1}}}`);
    });
    return texto;
  }

  // ── Matching de lead por teléfono ────────────────────────────
  // WA-BUG-03: el teléfono del lead en emp_leads suele estar cargado con
  // formato humano ("011 3430-3463"), pero el que manda Meta es solo
  // dígitos ("5491134303463"). Comparar el string crudo contra los dígitos
  // (como se hacía antes) casi nunca matcheaba por el espacio/guion en el
  // medio. Acá se resuelve en 2 pasos: 1) un filtro barato en la base por
  // los últimos 4 dígitos (en el formato argentino XXXX-XXXX esos 4 quedan
  // siempre juntos, sin guion en el medio, así que el ilike no falla ahí),
  // 2) comparación exacta en memoria normalizando (solo dígitos) los
  // candidatos que trajo ese filtro. Si el filtro trae más de un lead con
  // el mismo teléfono normalizado, no se linkea automático — es preferible
  // dejarlo sin asignar que asignarlo al lead equivocado.
  function soloDigitos(s) {
    return (s || "").replace(/\D/g, "");
  }

  async function buscarLeadPorTelefono(tenantId, telefonoWa) {
    const ultimos10 = soloDigitos(telefonoWa).slice(-10);
    const ultimos4 = ultimos10.slice(-4);
    if (!ultimos4) return null;
    const candidatos = await sbQuery(
      "emp_leads",
      `tenant_id=eq.${tenantId}&telefono=ilike.*${ultimos4}&select=id,telefono&limit=50`
    ).catch(() => []);
    const matches = candidatos.filter(l => soloDigitos(l.telefono).slice(-10) === ultimos10);
    return matches.length === 1 ? matches[0].id : null;
  }

  // ── Helpers de conversación ──────────────────────────────────
  async function getOrCreateConversacion(tenantId, telefono, nombreContacto) {
    const existentes = await sbQuery(
      "emp_whatsapp_conversaciones",
      `tenant_id=eq.${tenantId}&telefono=eq.${telefono}&select=*`
    );
    if (existentes[0]) return existentes[0];

    const leadId = await buscarLeadPorTelefono(tenantId, telefono);

    const nueva = await sbWrite("emp_whatsapp_conversaciones", "POST", {
      tenant_id: tenantId,
      telefono,
      nombre_contacto: nombreContacto || null,
      lead_id: leadId,
    });
    return nueva[0];
  }

  async function actualizarUltimoMensaje(conversacionId, texto, direccion, incrementarNoLeidos) {
    const conv = await sbQuery("emp_whatsapp_conversaciones", `id=eq.${conversacionId}&select=no_leidos`);
    const noLeidos = incrementarNoLeidos ? (conv[0]?.no_leidos || 0) + 1 : conv[0]?.no_leidos || 0;
    const ahora = new Date().toISOString();
    const patch = {
      ultimo_mensaje: texto,
      ultimo_mensaje_direccion: direccion,
      ultimo_mensaje_fecha: ahora,
      no_leidos: noLeidos,
    };
    // WA-MEJ-04/09: la ventana de 24hs para mandar texto libre se abre con
    // el ÚLTIMO MENSAJE DEL CONTACTO puntualmente, no con el último mensaje
    // de la conversación en general (que puede ser nuestro, y no reabre
    // nada). Por eso se guarda aparte y solo se pisa cuando el mensaje que
    // llega es "entrante" — si el agente responde después, esta fecha no
    // se toca, así la ventana sigue contando desde que escribió el cliente.
    // WA-MEJ-10: si el chat estaba oculto (el agente lo "eliminó" de la
    // lista) y el contacto vuelve a escribir, tiene que reaparecer en el
    // inbox — un mensaje nuevo no puede quedar escondido.
    if (direccion === "entrante") {
      patch.ultimo_entrante_fecha = ahora;
      patch.oculto = false;
    }
    return sbWrite("emp_whatsapp_conversaciones", "PATCH", patch, `?id=eq.${conversacionId}`);
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
    const { tenantId, telefono, mensaje, leadId, agenteId } = req.body || {};

    if (!tenantId || !telefono || !mensaje) {
      // Detalle de qué campo falta puntualmente — el mensaje genérico
      // anterior no alcanzaba para diagnosticar desde el frontend. Se loguea
      // el body completo (sin datos sensibles: son datos del propio lead)
      // para poder revisar en los logs de Render si vuelve a pasar.
      const faltantes = [];
      if (!tenantId) faltantes.push("tenantId");
      if (!telefono) faltantes.push("telefono");
      if (!mensaje) faltantes.push("mensaje");
      console.warn("[whatsapp] /send rechazado, faltan campos:", faltantes.join(", "), "— body recibido:", JSON.stringify(req.body));
      return res.status(400).json({
        error: `Faltan datos para enviar: ${faltantes.join(", ")}`,
        faltantes,
      });
    }

    try {
      const result = await sendTextMessage(telefono, mensaje);
      const waMessageId = result?.messages?.[0]?.id || null;
      const simulado = !!result?.__simulado;

      const conv = await getOrCreateConversacion(tenantId, telefono, null);
      if (leadId && !conv.lead_id) {
        await sbWrite("emp_whatsapp_conversaciones", "PATCH", { lead_id: leadId }, `?id=eq.${conv.id}`).catch(() => {});
      }

      await sbWrite("emp_whatsapp_mensajes", "POST", {
        conversacion_id: conv.id,
        direccion: "saliente",
        cuerpo: mensaje,
        wa_message_id: waMessageId,
        estado: simulado ? "simulado" : "enviado",
        agente_id: agenteId || null,
        tipo: "texto",
      });
      await actualizarUltimoMensaje(conv.id, simulado ? `[PRUEBA] ${mensaje}` : mensaje, "saliente", false);

      console.log(simulado
        ? `[whatsapp] Mensaje SIMULADO (falta configurar Meta) a ${telefono} (tenant ${tenantId})`
        : `[whatsapp] Mensaje enviado a ${telefono} (tenant ${tenantId})`);
      res.json({ ok: true, waMessageId, simulado });
    } catch (e) {
      console.error("[whatsapp] Error en /send:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /api/whatsapp/templates — WA-MEJ-04 ───────────────────
  // Trae las plantillas APPROVED (de Meta, o simuladas en modo prueba) ya
  // normalizadas para que el selector del panel no tenga que entender la
  // estructura de `components` de Meta. tenantId va en la query solo para
  // loguear/futura multi-WABA — hoy el WABA es uno solo por variable de
  // entorno, compartido por todos los tenants de esta instancia.
  router.get("/templates", async (req, res) => {
    const { tenantId } = req.query || {};
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Falta tenantId" });
    }
    try {
      const { plantillas, simulado } = await obtenerPlantillasAprobadas();
      if (simulado) {
        console.log(`[whatsapp] /templates: modo prueba (falta WHATSAPP_WABA_ID o credenciales) — sirviendo ${plantillas.length} plantillas simuladas.`);
      }
      res.json({ ok: true, simulado, plantillas });
    } catch (e) {
      console.error("[whatsapp] Error en /templates:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── POST /api/whatsapp/send-template — WA-MEJ-04 ──────────────
  // Manda un mensaje de plantilla aprobada. Si la plantilla tiene un
  // header de imagen/video/documento, se manda automáticamente con el
  // mismo archivo que quedó aprobado junto al texto (mediaHandle) — el
  // agente no adjunta nada acá, solo completa las variables del body.
  router.post("/send-template", async (req, res) => {
    const { tenantId, telefono, templateName, language, variables, leadId, agenteId } = req.body || {};

    const faltantes = [];
    if (!tenantId) faltantes.push("tenantId");
    if (!telefono) faltantes.push("telefono");
    if (!templateName) faltantes.push("templateName");
    if (!language) faltantes.push("language");
    if (faltantes.length) {
      console.warn("[whatsapp] /send-template rechazado, faltan campos:", faltantes.join(", "));
      return res.status(400).json({ error: `Faltan datos para enviar: ${faltantes.join(", ")}`, faltantes });
    }

    try {
      const { plantillas } = await obtenerPlantillasAprobadas();
      const plantilla = plantillas.find(p => p.name === templateName && p.language === language);
      if (!plantilla) {
        return res.status(400).json({ ok: false, error: `La plantilla "${templateName}" (${language}) no está aprobada o no existe.` });
      }
      if (plantilla.body.variables > 0 && (!Array.isArray(variables) || variables.length < plantilla.body.variables || variables.some(v => !String(v || "").trim()))) {
        return res.status(400).json({ ok: false, error: `Faltan completar variables de la plantilla (necesita ${plantilla.body.variables}).` });
      }

      const componentesEnvio = armarComponentesEnvio(plantilla, variables);
      const result = await sendTemplateMessage(telefono, templateName, language, componentesEnvio);
      const waMessageId = result?.messages?.[0]?.id || null;
      const simulado = !!result?.__simulado;
      const preview = renderizarPreviewPlantilla(plantilla, variables);

      const conv = await getOrCreateConversacion(tenantId, telefono, null);
      if (leadId && !conv.lead_id) {
        await sbWrite("emp_whatsapp_conversaciones", "PATCH", { lead_id: leadId }, `?id=eq.${conv.id}`).catch(() => {});
      }

      await sbWrite("emp_whatsapp_mensajes", "POST", {
        conversacion_id: conv.id,
        direccion: "saliente",
        cuerpo: preview,
        wa_message_id: waMessageId,
        estado: simulado ? "simulado" : "enviado",
        agente_id: agenteId || null,
        tipo: "template",
        template_name: templateName,
        media_id: plantilla.header?.mediaHandle || null,
        media_tipo: plantilla.header?.formato ? plantilla.header.formato.toLowerCase() : null,
      });
      await actualizarUltimoMensaje(conv.id, simulado ? `[PRUEBA] ${preview}` : preview, "saliente", false);

      console.log(simulado
        ? `[whatsapp] Plantilla SIMULADA (falta configurar Meta/WABA_ID) "${templateName}" a ${telefono} (tenant ${tenantId})`
        : `[whatsapp] Plantilla "${templateName}" enviada a ${telefono} (tenant ${tenantId})`);
      res.json({ ok: true, waMessageId, simulado });
    } catch (e) {
      console.error("[whatsapp] Error en /send-template:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── POST /api/whatsapp/send-template-masivo — WA-MEJ-11 / WA-MEJ-12 ──
  // Manda la misma plantilla aprobada a varios destinatarios a la vez.
  // Usado tanto desde la multi-selección de chats en WhatsAppPanel
  // (WA-MEJ-11) como desde la selección múltiple de Leads (WA-MEJ-12) —
  // mismo endpoint para no duplicar esta lógica en dos lugares. Secuencial
  // (no Promise.all) para no saturar la tasa de envío de Meta y para poder
  // guardar en `emp_whatsapp_envios_masivos.detalle` exactamente qué pasó
  // con cada destinatario.
  router.post("/send-template-masivo", async (req, res) => {
    const { tenantId, templateName, language, variables, destinatarios, agenteId } = req.body || {};

    const faltantes = [];
    if (!tenantId) faltantes.push("tenantId");
    if (!templateName) faltantes.push("templateName");
    if (!language) faltantes.push("language");
    if (!Array.isArray(destinatarios) || destinatarios.length === 0) faltantes.push("destinatarios");
    if (faltantes.length) {
      console.warn("[whatsapp] /send-template-masivo rechazado, faltan campos:", faltantes.join(", "));
      return res.status(400).json({ error: `Faltan datos para el envío masivo: ${faltantes.join(", ")}`, faltantes });
    }

    try {
      const { plantillas } = await obtenerPlantillasAprobadas();
      const plantilla = plantillas.find(p => p.name === templateName && p.language === language);
      if (!plantilla) {
        return res.status(400).json({ ok: false, error: `La plantilla "${templateName}" (${language}) no está aprobada o no existe.` });
      }
      if (plantilla.body.variables > 0 && (!Array.isArray(variables) || variables.length < plantilla.body.variables || variables.some(v => !String(v || "").trim()))) {
        return res.status(400).json({ ok: false, error: `Faltan completar variables de la plantilla (necesita ${plantilla.body.variables}).` });
      }

      // Fila de seguimiento en emp_whatsapp_envios_masivos, creada ANTES de
      // empezar a mandar — así si el envío es largo se puede consultar el
      // avance directo en Supabase mientras corre, no solo al terminar.
      const envioRows = await sbWrite("emp_whatsapp_envios_masivos", "POST", {
        tenant_id: tenantId,
        agente_id: agenteId || null,
        template_name: templateName,
        template_lang: language,
        total: destinatarios.length,
        enviados: 0,
        fallidos: 0,
        detalle: [],
      });
      const envio = envioRows[0];

      const componentesEnvio = armarComponentesEnvio(plantilla, variables);
      const preview = renderizarPreviewPlantilla(plantilla, variables);
      const detalle = [];
      let enviados = 0, fallidos = 0;

      for (const dest of destinatarios) {
        const telefono = soloDigitos(dest.telefono || "");
        if (!telefono) {
          detalle.push({ telefono: dest.telefono || null, leadId: dest.leadId || null, ok: false, error: "Teléfono inválido" });
          fallidos++;
          continue;
        }
        try {
          const result = await sendTemplateMessage(telefono, templateName, language, componentesEnvio);
          const waMessageId = result?.messages?.[0]?.id || null;
          const simulado = !!result?.__simulado;

          const conv = await getOrCreateConversacion(tenantId, telefono, null);
          if (dest.leadId && !conv.lead_id) {
            await sbWrite("emp_whatsapp_conversaciones", "PATCH", { lead_id: dest.leadId }, `?id=eq.${conv.id}`).catch(() => {});
          }
          await sbWrite("emp_whatsapp_mensajes", "POST", {
            conversacion_id: conv.id,
            direccion: "saliente",
            cuerpo: preview,
            wa_message_id: waMessageId,
            estado: simulado ? "simulado" : "enviado",
            agente_id: agenteId || null,
            tipo: "template",
            template_name: templateName,
            media_id: plantilla.header?.mediaHandle || null,
            media_tipo: plantilla.header?.formato ? plantilla.header.formato.toLowerCase() : null,
          });
          await actualizarUltimoMensaje(conv.id, simulado ? `[PRUEBA] ${preview}` : preview, "saliente", false);

          detalle.push({ telefono, leadId: dest.leadId || null, ok: true, simulado, waMessageId });
          enviados++;
        } catch (e) {
          detalle.push({ telefono, leadId: dest.leadId || null, ok: false, error: e.message });
          fallidos++;
        }
        // Pausa chica entre cada envío — throttle simple para no pegarle a la
        // Graph API de Meta de una sola vez en listas grandes.
        await new Promise(r => setTimeout(r, 300));
      }

      await sbWrite("emp_whatsapp_envios_masivos", "PATCH", { enviados, fallidos, detalle }, `?id=eq.${envio.id}`).catch(() => {});

      console.log(`[whatsapp] Envío masivo "${templateName}" (tenant ${tenantId}): ${enviados} ok, ${fallidos} fallidos de ${destinatarios.length}`);
      res.json({ ok: true, envioId: envio.id, total: destinatarios.length, enviados, fallidos, detalle });
    } catch (e) {
      console.error("[whatsapp] Error en /send-template-masivo:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { router };
};
