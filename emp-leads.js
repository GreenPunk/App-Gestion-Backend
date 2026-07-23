/**
 * ─────────────────────────────────────────────────────────────
 *  MÓDULO — Leads Emprendimientos
 *  IMAP polling (Gmail) + parser + reparto equitativo + endpoints
 * ─────────────────────────────────────────────────────────────
 */

const express       = require("express");
const crypto        = require("crypto");
const { ImapFlow }  = require("imapflow");
const { simpleParser } = require("mailparser");

const CASILLA_TENANT = {
  "nataliaalvarez.inmobiliaria@gmail.com": "6626aa9e-7f08-46a8-8692-4e2f9b69c6a3",
};
const REMITENTE_LEADS = "info@dicio.com.ar";

module.exports = function crearModuloLeads({ SB_URL, SB_KEY, sbQuery }) {
  const router = express.Router();

  async function sbWrite(method, table, body, query = "") {
    const res = await fetch(`${SB_URL}/rest/v1/${table}${query ? "?" + query : ""}`, {
      method,
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.text();
      throw new Error(`Supabase ${method} ${table} → ${res.status}: ${e}`);
    }
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [rows];
  }

  function toUuid(str) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
      return str.toLowerCase();
    }
    const hash = crypto.createHash("sha1").update(str).digest("hex");
    return [
      hash.slice(0, 8), hash.slice(8, 12),
      "5" + hash.slice(13, 16),
      ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join("-");
  }

  function parsearLeadEmail(parsedMail) {
    const text = parsedMail.text || "";
    const get = (label) => {
      const re = new RegExp(`^${label}:\\s*(.+?)\\s*$`, "m");
      const m = text.match(re);
      return m ? m[1].replace(/,\s*$/, "").trim() : null;
    };

    const leadIdRaw = get("Lead ID");
    if (!leadIdRaw) {
      console.warn(`[emp-leads] Mail sin "Lead ID" detectable — asunto: "${parsedMail.subject}". Se ignora.`);
      return null;
    }

    const estadoExterno = get("Estado");
    if (estadoExterno) console.log(`[emp-leads] Estado externo del lead (informativo): "${estadoExterno}"`);

    return {
      lead_id_externo:      toUuid(leadIdRaw),
      nombre:                get("Nombre"),
      email:                 get("Email"),
      telefono:              get("Telefono") || get("Teléfono"),
      fuente:                get("Fuente"),
      emprendimiento:        parsedMail.from?.value?.[0]?.name || null,
      fecha_creado_externo:  parseFechaArg(get("Creado")),
      mail_raw:              text,
    };
  }

  function parseFechaArg(str) {
    if (!str) return null;
    const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, d, mo, y, h, mi, s] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${s}-03:00`;
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  async function elegirAgenteEquitativo(tenantId) {
    const agentsRows = await sbQuery("agents", `tenant_id=eq.${tenantId}&select=id,data`);
    const activos = agentsRows.filter(a => a.data?.activo_leads === true);
    if (activos.length === 0) return null;

    const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const leadsRecientes = await sbQuery(
      "emp_leads",
      `tenant_id=eq.${tenantId}&created_at=gte.${encodeURIComponent(desde)}&select=agente_id`
    );

    const conteo = {};
    activos.forEach(a => { conteo[a.id] = 0; });
    leadsRecientes.forEach(l => { if (l.agente_id != null && conteo[l.agente_id] != null) conteo[l.agente_id]++; });

    let elegido = activos[0].id, min = Infinity;
    for (const a of activos) {
      const c = conteo[a.id] || 0;
      if (c < min) { min = c; elegido = a.id; }
    }
    return elegido;
  }

  async function addEvento(leadId, agenteId, tipo, detalle = null, estadoAnteriorId = null, estadoNuevoId = null) {
    return sbWrite("POST", "emp_lead_eventos", {
      lead_id: leadId, agente_id: agenteId, tipo, detalle,
      estado_anterior_id: estadoAnteriorId, estado_nuevo_id: estadoNuevoId,
    });
  }

  async function upsertLead(tenantId, lead) {
    const estados = await sbQuery("emp_lead_estados", `tenant_id=eq.${tenantId}&order=orden.asc&limit=1`);
    const estadoInicialId = estados[0]?.id || null;

    const rows = await sbWrite(
      "POST", "emp_leads",
      { tenant_id: tenantId, estado_id: estadoInicialId, ...lead },
      "on_conflict=tenant_id,lead_id_externo"
    );
    const row = rows[0];
    if (!row) return null;

    if (row.agente_id == null) {
      const agenteId = await elegirAgenteEquitativo(tenantId);
      if (agenteId) {
        await sbWrite("PATCH", `emp_leads?id=eq.${row.id}`, { agente_id: agenteId });
        await addEvento(row.id, agenteId, "nota", "Lead asignado automáticamente (reparto equitativo).");
        console.log(`[emp-leads] Lead ${row.id} asignado a agente ${agenteId}`);
      } else {
        console.warn(`[emp-leads] Lead ${row.id} sin agente disponible (ninguno activo)`);
      }
    }
    return row;
  }

  async function pollearCasilla(casilla, tenantId) {
    if (!process.env.GMAIL_APP_PASSWORD) {
      console.warn("[emp-leads] GMAIL_APP_PASSWORD no configurada — polling salteado");
      return;
    }
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: casilla, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ seen: false, from: REMITENTE_LEADS });
        if (uids.length === 0) return;
        console.log(`[emp-leads] ${uids.length} mail(s) nuevo(s) de ${REMITENTE_LEADS}`);

        for (const uid of uids) {
          try {
            const msg = await client.fetchOne(uid, { source: true });
            const parsed = await simpleParser(msg.source);
            const lead = parsearLeadEmail(parsed);
            if (lead) {
              const row = await upsertLead(tenantId, lead);
              console.log(`[emp-leads] Procesado lead_id_externo=${lead.lead_id_externo} → fila id=${row?.id}`);
            }
            await client.messageFlagsAdd(uid, ["\\Seen"]);
          } catch (e) {
            console.error(`[emp-leads] Error procesando uid=${uid}:`, e.message);
          }
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      console.error("[emp-leads] Error de conexión IMAP:", e.message);
    } finally {
      try { await client.logout(); } catch {}
    }
  }

  function iniciarPolling(intervaloMin = 3) {
    const correr = () => {
      Object.entries(CASILLA_TENANT).forEach(([casilla, tenantId]) => {
        pollearCasilla(casilla, tenantId).catch(e => console.error("[emp-leads] Error inesperado:", e.message));
      });
    };
    setInterval(correr, intervaloMin * 60 * 1000);
    setTimeout(correr, 20 * 1000);
    console.log(`[emp-leads] Polling IMAP activo cada ${intervaloMin} min`);
  }

  router.get("/emp-leads", async (req, res) => {
    try {
      const { tenant_id, estado_id, agente_id, fuente } = req.query;
      if (!tenant_id) return res.status(400).json({ error: "Falta tenant_id" });
      let q = `tenant_id=eq.${tenant_id}&select=*&order=created_at.desc`;
      if (estado_id) q += `&estado_id=eq.${estado_id}`;
      if (agente_id) q += `&agente_id=eq.${agente_id}`;
      if (fuente)    q += `&fuente=eq.${encodeURIComponent(fuente)}`;
      res.json(await sbQuery("emp_leads", q));
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.patch("/emp-leads/:id/estado", async (req, res) => {
    try {
      const { estado_nuevo_id, agente_id } = req.body;
      if (!estado_nuevo_id) return res.status(400).json({ error: "Falta estado_nuevo_id" });

      const actual = await sbQuery("emp_leads", `id=eq.${req.params.id}&select=estado_id`);
      const estadoAnteriorId = actual[0]?.estado_id || null;

      await sbWrite("PATCH", `emp_leads?id=eq.${req.params.id}`, { estado_id: estado_nuevo_id });
      await addEvento(req.params.id, agente_id || null, "cambio_estado", null, estadoAnteriorId, estado_nuevo_id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.patch("/emp-leads/:id/agente", async (req, res) => {
    try {
      const { agente_id } = req.body;
      if (!agente_id) return res.status(400).json({ error: "Falta agente_id" });
      await sbWrite("PATCH", `emp_leads?id=eq.${req.params.id}`, { agente_id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.post("/emp-leads/:id/eventos", async (req, res) => {
    try {
      const { agente_id, tipo, detalle } = req.body;
      if (!tipo) return res.status(400).json({ error: "Falta tipo" });
      const rows = await addEvento(req.params.id, agente_id || null, tipo, detalle || null);
      res.json({ ok: true, evento: rows[0] });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.get("/emp-leads/:id/eventos", async (req, res) => {
    try {
      res.json(await sbQuery("emp_lead_eventos", `lead_id=eq.${req.params.id}&select=*&order=created_at.desc`));
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.post("/emp-lead-estados", async (req, res) => {
    try {
      const { tenant_id, nombre, orden, color } = req.body;
      if (!tenant_id || !nombre) return res.status(400).json({ error: "Falta tenant_id o nombre" });
      const rows = await sbWrite("POST", "emp_lead_estados", {
        tenant_id, nombre, orden: orden ?? 99, color: color || "#888888",
      });
      res.json({ ok: true, estado: rows[0] });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.get("/emp-leads/stats", async (req, res) => {
    try {
      const { tenant_id } = req.query;
      if (!tenant_id) return res.status(400).json({ error: "Falta tenant_id" });

      const leads = await sbQuery("emp_leads", `tenant_id=eq.${tenant_id}&select=fuente,estado_id,agente_id,created_at`);

      const porFuente = {};
      const porEstado = {};
      const porAgente = {};
      leads.forEach(l => {
        porFuente[l.fuente || "sin_fuente"] = (porFuente[l.fuente || "sin_fuente"] || 0) + 1;
        porEstado[l.estado_id] = (porEstado[l.estado_id] || 0) + 1;
        porAgente[l.agente_id] = (porAgente[l.agente_id] || 0) + 1;
      });

      res.json({ total: leads.length, porFuente, porEstado, porAgente });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  router.patch("/agents/:id/leads-config", async (req, res) => {
    try {
      const { color, activo_leads } = req.body;
      const actual = await sbQuery("agents", `id=eq.${req.params.id}&select=data`);
      const dataActual = actual[0]?.data || {};
      const dataNueva = { ...dataActual };
      if (color !== undefined) dataNueva.color = color;
      if (activo_leads !== undefined) dataNueva.activo_leads = activo_leads;

      await sbWrite("PATCH", `agents?id=eq.${req.params.id}`, { data: dataNueva });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Error interno", detalle: e.message });
    }
  });

  return { router, iniciarPolling };
};
