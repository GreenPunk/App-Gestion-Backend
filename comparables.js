/**
 * ─────────────────────────────────────────────────────────────
 * MÓDULO — Comparables de mercado
 * Busca avisos en venta de una zona (Claude + búsqueda web), calcula
 * USD/m² y guarda las búsquedas en Supabase (comparables_busquedas).
 *
 *   POST /api/comparables/buscar     → busca y devuelve resultado (no guarda)
 *   POST /api/comparables/guardar    → guarda una búsqueda
 *   GET  /api/comparables/historial  → últimas 20 búsquedas del tenant
 *
 * Mismo patrón que emp-leads.js / emp-whatsapp.js: factory que recibe las
 * credenciales de Supabase ya armadas en server.js y devuelve un router.
 * No suma dependencias ni variables de entorno nuevas.
 * ─────────────────────────────────────────────────────────────
 */
const express = require("express");

const MODELO = process.env.COMPARABLES_MODEL || "claude-sonnet-4-5";
const MAX_BUSQUEDAS_WEB = Number(process.env.COMPARABLES_MAX_SEARCHES || 6);
const MAX_POR_HORA_Y_TENANT = Number(process.env.COMPARABLES_MAX_POR_HORA || 15);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un analista inmobiliario de Argentina. Tu tarea es buscar en la web avisos de propiedades EN VENTA que sirvan de comparables para una propiedad, y devolver los datos de cada aviso.

Reglas:
- Buscá en portales argentinos (Zonaprop, Argenprop, MercadoLibre Inmuebles, sitios de inmobiliarias de la zona).
- Usá solo avisos que hayas visto realmente en los resultados. Nunca inventes avisos, precios ni links.
- Si un dato no figura en el aviso, poné null. No lo estimes.
- Priorizá avisos de la zona indicada y de características parecidas (tipo, superficie, ambientes).
- Reportá el precio y la moneda tal como figuran en el aviso ("USD" o "ARS").
- Devolvé entre 5 y 15 avisos si los encontrás. Si encontrás menos, devolvé los que haya.

Respondé SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código, con esta forma:
{
  "avisos": [
    {
      "titulo": string,
      "ubicacion": string | null,
      "tipo": string | null,
      "precio": number | null,
      "moneda": "USD" | "ARS" | null,
      "m2_totales": number | null,
      "m2_cubiertos": number | null,
      "ambientes": number | null,
      "antiguedad": string | null,
      "caracteristicas": string[],
      "fuente": string,
      "link": string | null
    }
  ],
  "notas": string
}
En "notas" contá en una o dos frases qué tan buena fue la cobertura y cualquier limitación (pocos avisos, zona con poca oferta, datos incompletos).`;

function armarPrompt(p) {
  return [
    "Buscá comparables en VENTA para esta propiedad:",
    `- Zona / barrio: ${p.zona}`,
    `- Tipo: ${p.tipo || "no especificado"}`,
    p.m2 ? `- Superficie aproximada: ${p.m2} m²` : null,
    p.ambientes ? `- Ambientes: ${p.ambientes}` : null,
    p.notas ? `- Otras características a tener en cuenta: ${p.notas}` : null,
  ].filter(Boolean).join("\n");
}

// ── Parseo y validación ──────────────────────────────────────

function parsearJson(texto) {
  const limpio = texto.replace(/```json|```/g, "");
  const a = limpio.indexOf("{");
  const b = limpio.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("La respuesta no contiene JSON");
  return JSON.parse(limpio.slice(a, b + 1));
}

// Número positivo o null. Acepta number o string ("1.250.000", "85,5").
function aNumero(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizarAvisos(lista) {
  const vistos = new Set();
  const out = [];

  for (const raw of Array.isArray(lista) ? lista : []) {
    const precio = aNumero(raw.precio);
    if (!precio) continue; // sin precio no sirve como comparable

    const link = typeof raw.link === "string" && /^https?:\/\//.test(raw.link) ? raw.link : null;
    const clave = link || `${raw.titulo}|${precio}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const moneda = raw.moneda === "ARS" ? "ARS" : raw.moneda === "USD" ? "USD" : null;
    const m2Tot = aNumero(raw.m2_totales);
    const m2Cub = aNumero(raw.m2_cubiertos);
    const base = m2Tot || m2Cub;

    const flags = [];
    if (!moneda) flags.push("sin_moneda");
    if (moneda === "ARS") flags.push("en_pesos");
    if (!base) flags.push("sin_m2");
    if (!link) flags.push("sin_link");

    out.push({
      titulo: String(raw.titulo || "Aviso sin título"),
      ubicacion: raw.ubicacion || null,
      tipo: raw.tipo || null,
      precio,
      moneda,
      m2_totales: m2Tot,
      m2_cubiertos: m2Cub,
      ambientes: aNumero(raw.ambientes),
      antiguedad: raw.antiguedad || null,
      caracteristicas: Array.isArray(raw.caracteristicas) ? raw.caracteristicas.slice(0, 8).map(String) : [],
      fuente: String(raw.fuente || ""),
      link,
      usd_m2: moneda === "USD" && base ? Math.round(precio / base) : null,
      flags,
      atipico: false,
    });
  }
  return out;
}

// ── Estadísticas ─────────────────────────────────────────────

function percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const idx = (ordenado.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (idx - lo));
}

function calcularEstadisticas(avisos) {
  const validos = avisos.filter(a => a.usd_m2);
  if (!validos.length) return null;

  // Atípicos: menos de la mitad o más de 1,8 veces la mediana inicial
  const inicial = validos.map(a => a.usd_m2).sort((x, y) => x - y);
  const medIni = percentil(inicial, 0.5);
  for (const a of validos) a.atipico = a.usd_m2 < medIni * 0.5 || a.usd_m2 > medIni * 1.8;

  let usados = validos.filter(a => !a.atipico);
  if (usados.length < 3) {
    // Con muy pocos datos no descartamos nada
    validos.forEach(a => { a.atipico = false; });
    usados = validos;
  }

  const vals = usados.map(a => a.usd_m2).sort((x, y) => x - y);
  return {
    cantidad_usada: usados.length,
    cantidad_total: avisos.length,
    excluidos_atipicos: validos.length - usados.length,
    mediana_usd_m2: percentil(vals, 0.5),
    promedio_usd_m2: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
    p25_usd_m2: percentil(vals, 0.25),
    p75_usd_m2: percentil(vals, 0.75),
    min_usd_m2: vals[0],
    max_usd_m2: vals[vals.length - 1],
  };
}

// ── Módulo ───────────────────────────────────────────────────

module.exports = function crearModuloComparables({ SB_URL, SB_KEY, sbQuery, anthropic }) {
  const router = express.Router();

  // Límite simple en memoria por tenant (control de costo de la búsqueda web)
  const usoPorTenant = new Map(); // tenantId -> [timestamps]
  function excedeLimite(tenantId) {
    const ahora = Date.now();
    const recientes = (usoPorTenant.get(tenantId) || []).filter(t => ahora - t < 60 * 60 * 1000);
    if (recientes.length >= MAX_POR_HORA_Y_TENANT) {
      usoPorTenant.set(tenantId, recientes);
      return true;
    }
    recientes.push(ahora);
    usoPorTenant.set(tenantId, recientes);
    return false;
  }

  async function sbInsert(table, body) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: "POST",
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
      throw new Error(`Supabase POST ${table} → ${res.status}: ${e}`);
    }
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function buscarConClaude(params) {
    let messages = [{ role: "user", content: armarPrompt(params) }];
    const pedir = () => anthropic.messages.create({
      model: MODELO,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: MAX_BUSQUEDAS_WEB,
        user_location: {
          type: "approximate",
          country: "AR",
          region: "Buenos Aires",
          timezone: "America/Argentina/Buenos_Aires",
        },
      }],
      messages,
    });

    let resp = await pedir();

    // Las búsquedas web del lado del servidor pueden pausar el turno: lo retomamos.
    let vueltas = 0;
    while (resp.stop_reason === "pause_turn" && vueltas < 3) {
      messages = [...messages, { role: "assistant", content: resp.content }];
      resp = await pedir();
      vueltas += 1;
    }

    return resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }

  router.post("/buscar", async (req, res) => {
    try {
      const { tenant_id, zona, tipo, m2, ambientes, notas } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!zona || !String(zona).trim()) return res.status(400).json({ error: "Indicá la zona o el barrio" });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en el backend" });
      if (excedeLimite(tenant_id)) {
        return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA_Y_TENANT} búsquedas por hora. Probá más tarde.` });
      }

      const params = {
        zona: String(zona).trim().slice(0, 120),
        tipo: tipo ? String(tipo).slice(0, 60) : null,
        m2: aNumero(m2),
        ambientes: aNumero(ambientes),
        notas: notas ? String(notas).slice(0, 300) : null,
      };

      const texto = await buscarConClaude(params);

      let parsed;
      try {
        parsed = parsearJson(texto);
      } catch {
        return res.status(502).json({ error: "No pude interpretar la respuesta de la búsqueda. Probá de nuevo." });
      }

      const avisos = normalizarAvisos(parsed.avisos);
      res.json({
        parametros: params,
        avisos,
        estadisticas: calcularEstadisticas(avisos),
        notas: typeof parsed.notas === "string" ? parsed.notas : "",
        generado: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[comparables] buscar:", err);
      res.status(500).json({ error: "Falló la búsqueda de comparables", detalle: err.message });
    }
  });

  router.post("/guardar", async (req, res) => {
    try {
      const { tenant_id, parametros, resultado } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!parametros || !resultado) return res.status(400).json({ error: "Faltan parametros o resultado" });
      const fila = await sbInsert("comparables_busquedas", { tenant_id, data: { parametros, resultado } });
      res.json({ id: fila.id, created_at: fila.created_at });
    } catch (err) {
      console.error("[comparables] guardar:", err);
      res.status(500).json({ error: "No se pudo guardar la búsqueda", detalle: err.message });
    }
  });

  router.get("/historial", async (req, res) => {
    try {
      const { tenant_id } = req.query;
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      const filas = await sbQuery(
        "comparables_busquedas",
        `tenant_id=eq.${tenant_id}&select=id,data,created_at&order=created_at.desc&limit=20`
      );
      res.json(filas);
    } catch (err) {
      console.error("[comparables] historial:", err);
      res.status(500).json({ error: "No se pudo leer el historial", detalle: err.message });
    }
  });

  return { router };
};

// Solo para tests locales
module.exports._internals = { armarPrompt, parsearJson, aNumero, normalizarAvisos, calcularEstadisticas, percentil };
