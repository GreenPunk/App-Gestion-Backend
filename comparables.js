/**
 * ─────────────────────────────────────────────────────────────
 * MÓDULO — Comparables de mercado
 * Busca avisos en venta de una zona (Claude + búsqueda web), calcula
 * USD/m², ubica los avisos en el mapa y guarda las búsquedas en
 * Supabase (comparables_busquedas).
 *
 *   POST /api/comparables/buscar        → busca (hasta 15 avisos) o amplía (ampliar + previos). No guarda.
 *                                         Solo muestra avisos con link real (que la búsqueda devolvió) y con los datos de su propia página
 *   POST /api/comparables/geocodificar  → ubica avisos en el mapa (Nominatim / OpenStreetMap)
 *   POST /api/comparables/guardar       → guarda una búsqueda
 *   GET  /api/comparables/historial     → últimas 100 búsquedas del tenant (con su grupo, si tienen)
 *   POST /api/comparables/propiedades/actualizar → trae propiedades nuevas y datos faltantes desde Tokko (usa tenants.tokko_key)
 *   POST /api/comparables/historial/agrupar → pone (o saca) un grupo a una o varias búsquedas guardadas
 *   POST /api/comparables/historial/borrar  → borra una o varias búsquedas guardadas
 *   POST /api/comparables/historial/completar → completa o corrige avisos guardados, sin repetir la búsqueda ni gastar tokens:
 *                                         modo "pagina" (vuelve a leer el link), "texto" (texto pegado) o "manual" (carga a mano)
 *   GET  /api/comparables/para-tasacion → avisos de la búsqueda guardada de una propiedad, en el esquema de Tasaciones, con su fecha
 *
 * Cada aviso trae, además de precio y superficies: dormitorios, baños, estacionamiento, antigüedad, condición, orientación,
 * disposición y expensas, leídos de la ficha de cada portal (Argenprop, Zonaprop, MercadoLibre) con su cita textual.
 * origen_campos dice de dónde salió cada dato (pagina, texto_pegado, manual); faltantes y completitud, qué no se publicó.
 *
 * Mismo patrón que emp-leads.js / emp-whatsapp.js: factory que recibe las
 * credenciales de Supabase ya armadas en server.js y devuelve un router.
 * No suma dependencias ni variables de entorno nuevas.
 * Opcionales: COMPARABLES_MODEL, COMPARABLES_MAX_SEARCHES (10),
 * COMPARABLES_MAX_POR_HORA (15), COMPARABLES_MAX_AVISOS (20),
 * COMPARABLES_GEO_POR_HORA (400), COMPARABLES_COMPLETAR_POR_HORA (60), GEOCODER_UA.
 * ─────────────────────────────────────────────────────────────
 */
const express = require("express");
const dnsP = require("dns").promises;
const net = require("net");

// Consumo de tokens: el modelo y la cantidad de búsquedas web son lo que más pesa en el costo.
// Haiku 4.5 sale unas 3 veces más barato que Sonnet 4.5. Si el modelo elegido falla (por ejemplo, no admite la
// búsqueda web), se reintenta una vez con MODELO_RESPALDO.
const MODELO = process.env.COMPARABLES_MODEL || "claude-haiku-4-5-20251001";
const MODELO_RESPALDO = process.env.COMPARABLES_MODEL_RESPALDO || "claude-sonnet-4-5";
const MAX_BUSQUEDAS_WEB = Number(process.env.COMPARABLES_MAX_SEARCHES || 6);
const MAX_POR_HORA_Y_TENANT = Number(process.env.COMPARABLES_MAX_POR_HORA || 8);
const MAX_POR_DIA_Y_TENANT = Number(process.env.COMPARABLES_MAX_POR_DIA || 20);
const MAX_AVISOS_POR_BUSQUEDA = Number(process.env.COMPARABLES_MAX_AVISOS || 15);
const CACHE_HORAS = Number(process.env.COMPARABLES_CACHE_HORAS || 12);
const MAX_TOKENS_SALIDA = Number(process.env.COMPARABLES_MAX_TOKENS || 6000);
// Precios de lista en USD por millón de tokens (entrada, salida) y por búsqueda web. Si el modelo no figura acá,
// el costo no se estima (se puede definir con COMPARABLES_PRECIO_ENTRADA / COMPARABLES_PRECIO_SALIDA).
const PRECIO_BUSQUEDA_WEB_USD = 0.01;
function preciosDeModelo(modelo) {
  const env_in = Number(process.env.COMPARABLES_PRECIO_ENTRADA);
  const env_out = Number(process.env.COMPARABLES_PRECIO_SALIDA);
  if (env_in > 0 && env_out > 0) return { entrada: env_in, salida: env_out };
  if (/haiku-4-5|haiku-4\.5/i.test(modelo)) return { entrada: 1, salida: 5 };
  if (/sonnet-4/i.test(modelo)) return { entrada: 3, salida: 15 };
  return null;
}
function costoEstimado(uso, modelo) {
  const pr = preciosDeModelo(modelo);
  if (!pr) return null;
  const usd = (uso.input_tokens * pr.entrada + uso.output_tokens * pr.salida) / 1e6 + uso.busquedas * PRECIO_BUSQUEDA_WEB_USD;
  return Math.round(usd * 1000) / 1000;
}

// Verificación de links: antes de mostrar un aviso se abre su link y se comprueba que la página sea el aviso
// y que sus datos (precio, superficie, dirección) se vean ahí.
//   marcar (por defecto): quedan los avisos cuyo link existe pero no se pudo leer, marcados como "sin verificar"
//     y fuera de las estadísticas
//   estricto: solo quedan los avisos verificados; el resto se descarta y se informa por qué
//   off: no se verifica
// En cualquier modo, un aviso cuyo link NO aparece en los resultados de la búsqueda web (lo armó el modelo) o que no
// trae link se descarta siempre: nunca se muestra un dato sin un link real detrás.
const VERIFICAR_MODO = ["estricto", "marcar", "off"].includes(process.env.COMPARABLES_VERIFICAR_LINKS)
  ? process.env.COMPARABLES_VERIFICAR_LINKS : "marcar";
const VERIF_TIMEOUT_MS = Number(process.env.COMPARABLES_VERIF_TIMEOUT_MS || 9000);
const VERIF_PRESUPUESTO_MS = Number(process.env.COMPARABLES_VERIF_PRESUPUESTO_MS || 35000);
// Avisos que el servidor lee por su cuenta (de los listados que devolvió la búsqueda), además de los del modelo
const MAX_CANDIDATOS = Number(process.env.COMPARABLES_MAX_CANDIDATOS || 24);
const MAX_LISTADOS_A_LEER = 4;
const MAX_LINKS_POR_LISTADO = 10;
const VERIF_CONCURRENCIA = 6;
const VERIF_MAX_BYTES = 1500000;
const VERIF_UA = process.env.COMPARABLES_VERIF_UA || "Mozilla/5.0 (compatible; GestionInmobiliaria-Comparables/1.0; uso interno)";
const MAX_AVISOS_TOTAL = 60;
const MAX_GEO_POR_HORA = Number(process.env.COMPARABLES_GEO_POR_HORA || 400);
const GEOCODER_UA = process.env.GEOCODER_UA || "GestionInmobiliaria-Comparables/1.0 (uso interno de inmobiliarias)";
const MAX_DISTANCIA_GEO_KM = 60; // más lejos que esto del centro, se descarta (probable homónimo)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un analista inmobiliario de Argentina. Buscá en la web avisos de propiedades EN VENTA que sirvan de comparables y devolvé los datos de cada uno.

Reglas:
- Buscá en portales argentinos (Zonaprop, Argenprop, MercadoLibre Inmuebles, sitios de inmobiliarias de la zona).
- Usá solo avisos que hayas visto realmente en los resultados. Nunca inventes avisos, precios, direcciones ni links. Si un dato no figura, poné null: no lo estimes. Copiá cada dato tal cual figura en el aviso, sin combinar datos de avisos distintos y sin completar los que faltan.
- Priorizá avisos de la zona indicada y de características parecidas (tipo, superficie, ambientes).
- Precio y moneda tal como figuran ("USD" o "ARS").
- "link": la URL exacta del aviso individual, copiada de los resultados de la búsqueda. El servidor DESCARTA todo aviso cuyo link no figure literalmente en esos resultados. Nunca armes una URL a partir del título, de la inmobiliaria o de un patrón. Si el resultado es una página de listado que no muestra el link de cada aviso, no incluyas esos avisos: el servidor lee los listados por su cuenta. Cada link se va a abrir para comprobar que muestre los datos que informás. Es preferible devolver pocos avisos o ninguno antes que uno con un link o un dato dudoso.
- No repitas el mismo inmueble publicado en distintos portales o inmobiliarias (misma dirección y mismo precio): incluilo una sola vez.
- Devolvé hasta ${MAX_AVISOS_POR_BUSQUEDA} avisos distintos y dejá de buscar cuando los tengas o cuando no aparezcan avisos nuevos. Priorizá los que publican precio.
- Superficies, cada dato en su campo y solo si el aviso lo dice (un 0 explícito va como 0; si no figura, null; no calcules por diferencia): "m2_cubiertos", "m2_semicubiertos", "m2_descubiertos" (patio, jardín, terraza descubierta), "m2_balcon", "m2_terreno", "m2_totales".
- Ubicación: "direccion" es calle y altura, solo si figuran. "barrio" es barrio, urbanización o barrio cerrado. "localidad" es localidad o partido. "ubicacion" es la ubicación tal como la muestra el aviso; si el resultado no muestra la dirección, usá la zona que aparece en el título o en la URL (por ejemplo "Garín, Escobar"). "ubicacion_origen" dice de dónde sacaste la ubicación: "direccion" (calle y altura publicadas), "mapa" (el aviso muestra un mapa o una ubicación aproximada), "titulo_o_url" (solo la zona del título o de la URL) o "ninguna".
- "caracteristicas": como máximo 3, de una a tres palabras cada una.
- "hay_mas": true si tenés indicios de que existen más avisos comparables que no incluiste.

Respondé SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código:
{"avisos":[{"titulo":string,"ubicacion":string|null,"ubicacion_origen":"direccion"|"mapa"|"titulo_o_url"|"ninguna","direccion":string|null,"barrio":string|null,"localidad":string|null,"tipo":string|null,"precio":number|null,"moneda":"USD"|"ARS"|null,"m2_totales":number|null,"m2_cubiertos":number|null,"m2_semicubiertos":number|null,"m2_descubiertos":number|null,"m2_balcon":number|null,"m2_terreno":number|null,"ambientes":number|null,"antiguedad":string|null,"caracteristicas":string[],"fuente":string,"link":string}],"hay_mas":boolean,"notas":string}
En "notas" contá en una frase la cobertura y cualquier limitación (pocos avisos, zona con poca oferta, datos incompletos).`;

function armarPrompt(p, previos) {
  const lineas = [
    "Buscá comparables en VENTA para esta propiedad:",
    `- Zona / barrio: ${p.zona}`,
    `- Tipo: ${p.tipo || "no especificado"}`,
    p.m2 ? `- Superficie aproximada: ${p.m2} m²` : null,
    p.ambientes ? `- Ambientes: ${p.ambientes}` : null,
    p.notas ? `- Otras características a tener en cuenta: ${p.notas}` : null,
  ];
  if (Array.isArray(previos) && previos.length) {
    lineas.push(
      "",
      "Ya tenés estos avisos. NO los repitas: buscá otros distintos.",
      ...previos.slice(0, MAX_AVISOS_TOTAL).map(a =>
        `- ${String(a.titulo || "").replace(/\s+/g, " ").slice(0, 80)} | ${a.link || "sin link"}`
      )
    );
  }
  return lineas.filter(l => l !== null).join("\n");
}

// ── Parseo y validación ──────────────────────────────────────

function parsearJson(texto) {
  const limpio = texto.replace(/```json|```/g, "");
  const a = limpio.indexOf("{");
  const b = limpio.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("La respuesta no contiene JSON");
  return JSON.parse(limpio.slice(a, b + 1));
}

// Objetos JSON completos (llaves balanceadas, respetando textos entre comillas) que aparecen dentro de un texto.
// Sirve cuando el modelo escribe comentarios antes o después del JSON, o cuando la respuesta quedó cortada.
function objetosJson(texto) {
  const out = [];
  let i = 0;
  while (i < texto.length) {
    if (texto[i] !== "{") { i++; continue; }
    let prof = 0, enTexto = false, esc = false, j = i, cerro = false;
    for (; j < texto.length; j++) {
      const c = texto[j];
      if (enTexto) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') enTexto = false;
        continue;
      }
      if (c === '"') enTexto = true;
      else if (c === "{") prof++;
      else if (c === "}") { prof--; if (prof === 0) { cerro = true; break; } }
    }
    if (cerro) { out.push(texto.slice(i, j + 1)); i = j + 1; } else { i++; }
  }
  return out;
}

// Lee la respuesta del modelo con tolerancia. `textos` son los bloques de texto (el último primero).
// Devuelve { parsed, recuperado }: recuperado = true si hubo que rescatar los avisos de una respuesta cortada.
// Si no hay forma de leerla, lanza un Error.
function parsearRespuestaModelo(textos) {
  const lista = (Array.isArray(textos) ? textos : [textos]).filter(t => typeof t === "string" && t.trim());
  const candidatos = [...lista, lista.join("\n")];
  for (const t of candidatos) {
    const limpio = t.replace(/```json|```/g, "");
    // Prefiere el objeto más grande que tenga la lista de avisos
    const validos = [];
    for (const o of objetosJson(limpio)) {
      try {
        const p = JSON.parse(o);
        if (p && typeof p === "object" && Array.isArray(p.avisos)) validos.push({ p, largo: o.length });
      } catch { /* no era JSON: sigue */ }
    }
    if (validos.length) {
      validos.sort((x, y) => y.largo - x.largo);
      return { parsed: validos[0].p, recuperado: false };
    }
  }
  // Respuesta cortada: se rescatan los avisos que quedaron completos
  for (const t of candidatos) {
    const m = /"avisos"\s*:\s*\[/.exec(t);
    if (!m) continue;
    const avisos = [];
    for (const o of objetosJson(t.slice(m.index + m[0].length))) {
      try { const a = JSON.parse(o); if (a && typeof a === "object") avisos.push(a); } catch { /* aviso roto: se omite */ }
    }
    if (avisos.length) return { parsed: { avisos, hay_mas: true, notas: "La respuesta del modelo llegó cortada: se muestran los avisos que alcanzaron a completarse." }, recuperado: true };
  }
  throw new Error("La respuesta no contiene JSON de avisos");
}

// Número positivo o null. Acepta number o string ("1.250.000", "85,5").
function aNumero(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Como aNumero, pero conserva un 0 explícito (el aviso dice "0 m² descubiertos")
function aNumeroOCero(v) {
  if (v === 0 || (typeof v === "string" && /^\s*0+([.,]0+)?\s*$/.test(v))) return 0;
  return aNumero(v);
}

// Texto corto o null
function aTexto(v, max = 120) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// Link sin parámetros de tracking ni #ancla. Devuelve null si no es http(s).
function limpiarLink(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === "gclid" || k === "fbclid") u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return null;
  }
}

// Clave para comparar links (sin www, sin query, sin barra final, en minúsculas)
function claveLink(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return null;
  }
}

function hashCorto(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// URLs que aparecieron de verdad en los resultados de la búsqueda web
function recolectarUrls(bloques) {
  const claves = new Set();
  for (const b of bloques || []) {
    if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        const k = r?.url && claveLink(r.url);
        if (k) claves.add(k);
      }
    }
    if (Array.isArray(b?.citations)) {
      for (const c of b.citations) {
        const k = c?.url && claveLink(c.url);
        if (k) claves.add(k);
      }
    }
  }
  return claves;
}

// Resultados que la búsqueda web devolvió de verdad: [{ url, titulo }]
function recolectarResultados(bloques) {
  const vistos = new Set();
  const out = [];
  for (const b of bloques || []) {
    if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        const url = limpiarLink(r?.url);
        const k = url && claveLink(url);
        if (k && !vistos.has(k)) { vistos.add(k); out.push({ url, titulo: aTexto(r?.title, 160) }); }
      }
    }
  }
  return out;
}

// ¿La URL parece la de un aviso individual? Los portales ponen el código del aviso en la ruta (6 dígitos o más)
function pareceUrlDeAviso(url) {
  try {
    const ruta = new URL(url).pathname.toLowerCase();
    if (ruta.replace(/\//g, "") === "") return false;
    if (/\.(jpe?g|png|webp|gif|svg|pdf|css|js)$/.test(ruta)) return false;
    return /\d{6,}/.test(ruta);
  } catch {
    return false;
  }
}

// Nombre del portal según el dominio del link (no lo decide el modelo)
function fuenteDeLink(link) {
  try {
    const h = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
    if (h.includes("argenprop")) return "Argenprop";
    if (h.includes("zonaprop")) return "Zonaprop";
    if (h.includes("mercadolibre")) return "MercadoLibre";
    if (h.includes("remax")) return "REMAX";
    if (h.includes("properati")) return "Properati";
    return h;
  } catch {
    return null;
  }
}

// Superficie sobre la que se calcula el USD/m², con el mismo método que ModuloTasaciones (supComp):
//  - terrenos: superficie del terreno (o total)
//  - resto: SOLO si el aviso publica la superficie cubierta. Se usan todos los datos que traiga:
//    cubierta×1 + semicubierta×0.5 + descubierta×0.2 + balcón×0.33
//  - si no publica la cubierta (solo la total, o nada), no se calcula nada: el aviso entra
//    únicamente en las estadísticas del precio publicado.
// base: "terreno" | "homologada" (cubierta + algún dato más) | "homologada_parcial" (solo cubierta) | null
function superficieBase({ tipo, m2Tot, m2Cub, m2Sem, m2Des, m2Bal, m2Ter }) {
  const esTerreno = /lote|terreno/i.test(tipo || "");
  if (esTerreno) {
    const m2 = m2Ter || m2Tot;
    return { m2: m2 || null, base: m2 ? "terreno" : null };
  }
  if (!m2Cub) return { m2: null, base: null };
  const m2 = m2Cub + (m2Sem || 0) * 0.5 + (m2Des || 0) * 0.2 + (m2Bal || 0) * 0.33;
  const completa = m2Sem != null || m2Des != null || m2Bal != null;
  return { m2, base: completa ? "homologada" : "homologada_parcial" };
}

// urlsVistas: Set de claves de links vistos en la búsqueda (o null para no verificar,
// por ejemplo con avisos que ya vienen de una búsqueda anterior)
const ORIGENES_UBICACION = ["direccion", "mapa", "titulo_o_url", "ninguna"];

// ── Datos del aviso para tasar: núcleo y opcionales ──────────
// Núcleo: lo que hace falta para usar el aviso como comparable. Opcionales: suman información pero no bloquean nada.
// "Faltante" quiere decir que el aviso no lo publica (o no se pudo leer): nunca se completa por deducción.
const aEnteroHasta = (v, max) => { const n = aNumeroOCero(v); return n != null && Number.isInteger(n) && n <= max ? n : null; };
const aExpensas = v => {
  if (!v || typeof v !== "object") return null;
  const monto = aNumero(v.monto);
  return monto && (v.moneda === "ARS" || v.moneda === "USD") ? { monto, moneda: v.moneda } : null;
};
const ORIGENES_DATO = ["pagina", "texto_pegado", "manual", "busqueda"];
function sanearOrigen(o) {
  if (!o || typeof o !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 40)) if (/^[a-z0-9_]{1,24}$/.test(k) && ORIGENES_DATO.includes(v)) out[k] = v;
  return Object.keys(out).length ? out : null;
}
function sanearOriginales(o) {
  if (!o || typeof o !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 20)) {
    if (!/^[a-z0-9_]{1,24}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 80);
    else if (v && typeof v === "object" && aExpensas(v)) out[k] = aExpensas(v);
  }
  return Object.keys(out).length ? out : null;
}

const TIPOS_COMERCIALES = /local|oficina|galpon|deposito|cochera|fondo de comercio/;
const TIPOS_CON_TERRENO = /casa|quinta|chalet|chacra|campo/;
function datosDelAviso(a) {
  const tipo = sinTildes(a.tipo || "");
  const esLote = /lote|terreno/.test(tipo);
  const esComercial = TIPOS_COMERCIALES.test(tipo);
  const tiene = c => (c === "precio" ? !!(a.precio && a.moneda) : a[c] != null);
  let nucleo;
  if (esLote) nucleo = ["precio", a.m2_terreno != null || a.m2_totales == null ? "m2_terreno" : "m2_totales"];
  else if (esComercial) nucleo = ["precio", "m2_cubiertos", "antiguedad", "condicion"];
  else {
    nucleo = ["precio", "m2_cubiertos", "dormitorios", "banos", "estacionamiento", "antiguedad", "condicion"];
    if (TIPOS_CON_TERRENO.test(tipo)) nucleo.push("m2_terreno");
  }
  const opcionales = esLote ? ["orientacion", "expensas"] : ["ambientes", "orientacion", "disposicion", "expensas", "m2_semicubiertos", "m2_descubiertos", "m2_balcon"];
  return { nucleo, opcionales, tiene };
}
// faltantes: del núcleo · faltantes_opc: de los opcionales · completitud: % del núcleo que el aviso trae
function completitudDe(a) {
  const { nucleo, opcionales, tiene } = datosDelAviso(a);
  const faltantes = nucleo.filter(c => !tiene(c));
  return {
    faltantes,
    faltantes_opc: opcionales.filter(c => !tiene(c)),
    completitud: Math.round(((nucleo.length - faltantes.length) / nucleo.length) * 100),
  };
}

// Lo que el modelo no tiene que decidir (lo agrega el servidor): se descarta de su respuesta
function limpiarSalidaModelo(lista) {
  return (Array.isArray(lista) ? lista : []).map(r =>
    r && typeof r === "object"
      ? { ...r, verificacion: undefined, lat: undefined, lng: undefined, ubic_precision: undefined, ubic_origen: undefined, flags: undefined,
        dormitorios: undefined, banos: undefined, estacionamiento: undefined, condicion: undefined, orientacion: undefined, disposicion: undefined, expensas: undefined,
        origen_campos: undefined, originales: undefined, editado_a_mano: undefined, confirmado_a_mano: undefined, faltantes: undefined, faltantes_opc: undefined, completitud: undefined }
      : r
  );
}

function normalizarAvisos(lista, urlsVistas) {
  const vistos = new Set();
  const out = [];

  for (const raw of Array.isArray(lista) ? lista : []) {
    if (!raw || typeof raw !== "object") continue;
    const precio = aNumero(raw.precio);
    const link = limpiarLink(raw.link);
    const titulo = String(raw.titulo || "Aviso sin título").slice(0, 200);
    const clave = (link && claveLink(link)) || `${titulo}|${precio || ""}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const moneda = !precio ? null : raw.moneda === "ARS" ? "ARS" : raw.moneda === "USD" ? "USD" : null;
    const m2Tot = aNumero(raw.m2_totales);
    const m2Cub = aNumero(raw.m2_cubiertos);
    const m2Sem = aNumeroOCero(raw.m2_semicubiertos);
    const m2Des = aNumeroOCero(raw.m2_descubiertos);
    const m2Bal = aNumeroOCero(raw.m2_balcon);
    const m2Ter = aNumero(raw.m2_terreno);
    const tipoAviso = aTexto(raw.tipo, 60);
    const sup = superficieBase({ tipo: tipoAviso, m2Tot, m2Cub, m2Sem, m2Des, m2Bal, m2Ter });
    const base = sup.m2;

    const origenOk = sanearOrigen(raw.origen_campos);
    const originalesOk = sanearOriginales(raw.originales);

    const flags = [];
    if (!precio) flags.push("sin_precio");
    else if (!moneda) flags.push("sin_moneda");
    if (moneda === "ARS") flags.push("en_pesos");
    const esTerrenoAviso = /lote|terreno/i.test(tipoAviso || "");
    if (!base) flags.push(esTerrenoAviso ? "sin_m2" : "sin_cubierta");
    if (base && sup.base === "homologada_parcial") flags.push("sup_parcial");
    if (raw.verificacion && typeof raw.verificacion.estado === "string" && raw.verificacion.estado !== "verificado") flags.push("no_verificado");
    if (!link) flags.push("sin_link");
    else if (urlsVistas ? urlsVistas.size > 0 && !urlsVistas.has(claveLink(link))
                        : Array.isArray(raw.flags) && raw.flags.includes("link_no_verificado")) {
      flags.push("link_no_verificado");
    }

    const aviso = {
      id: hashCorto(clave),
      titulo,
      ubicacion: aTexto(raw.ubicacion),
      direccion: aTexto(raw.direccion),
      barrio: aTexto(raw.barrio),
      localidad: aTexto(raw.localidad),
      tipo: tipoAviso,
      precio,
      moneda,
      m2_totales: m2Tot,
      m2_cubiertos: m2Cub,
      m2_semicubiertos: m2Sem,
      m2_descubiertos: m2Des,
      m2_balcon: m2Bal,
      m2_terreno: m2Ter,
      m2_homologados: base ? Math.round(base * 100) / 100 : null,
      base_m2: sup.base,
      ambientes: aNumero(raw.ambientes),
      antiguedad: aTexto(raw.antiguedad, 60),
      caracteristicas: Array.isArray(raw.caracteristicas) ? raw.caracteristicas.slice(0, 8).map(c => String(c).slice(0, 60)) : [],
      // Datos de la ficha: salen de la página, de un texto pegado o de una carga manual (ver origen_campos); el modelo no los escribe
      dormitorios: aEnteroHasta(raw.dormitorios, 30),
      banos: aEnteroHasta(raw.banos, 30),
      estacionamiento: aEnteroHasta(raw.estacionamiento, 30),
      condicion: aTexto(raw.condicion, 40),
      orientacion: aTexto(raw.orientacion, 30),
      disposicion: aTexto(raw.disposicion, 30),
      expensas: aExpensas(raw.expensas),
      ...(origenOk ? { origen_campos: origenOk } : {}),
      ...(originalesOk ? { originales: originalesOk } : {}),
      ...(raw.editado_a_mano ? { editado_a_mano: true } : {}),
      ...(raw.confirmado_a_mano ? { confirmado_a_mano: true } : {}),
      fuente: String(raw.fuente || "").slice(0, 60),
      ubicacion_origen: ORIGENES_UBICACION.includes(raw.ubicacion_origen) ? raw.ubicacion_origen : null,
      link,
      motivo_sin_link: link ? null : aTexto(raw.motivo_sin_link, 140),
      // Lo que agrega el servidor al verificar el link (ver verificarAvisos). Se conserva al ampliar y al guardar.
      ...(Array.isArray(raw.datos_pagina) && raw.datos_pagina.length ? { datos_pagina: raw.datos_pagina.slice(0, 10).map(x => String(x).slice(0, 20)) } : {}),
      // Aviso que el servidor encontró en un listado y leyó de su propia página (el modelo no escribió nada)
      ...(raw.solo_pagina ? { solo_pagina: true } : {}),
      // Lo que la página dice textualmente, para comparar a ojo: [{ campo, texto }]
      ...(Array.isArray(raw.evidencia) && raw.evidencia.length
        ? { evidencia: raw.evidencia.slice(0, 24).map(e => ({ campo: String(e?.campo || "").slice(0, 20), texto: String(e?.texto || "").slice(0, 90) })).filter(e => e.campo && e.texto) }
        : {}),
      ...(raw.verificacion && typeof raw.verificacion.estado === "string"
        ? { verificacion: { estado: raw.verificacion.estado.slice(0, 20), motivo: aTexto(raw.verificacion.motivo, 200) } }
        : {}),
      ...(Number.isFinite(raw.lat) && Number.isFinite(raw.lng) && coordValida(raw.lat, raw.lng)
        ? { lat: raw.lat, lng: raw.lng, ubic_precision: ["exacta", "calle"].includes(raw.ubic_precision) ? raw.ubic_precision : "calle", ubic_origen: "pagina" }
        : {}),
      usd_m2: moneda === "USD" && base ? Math.round(precio / base) : null,
      flags,
      atipico: false,
    };
    Object.assign(aviso, completitudDe(aviso));
    out.push(aviso);
  }
  return out;
}

// Mismo inmueble en distintos portales: misma dirección y mismo precio. Se queda con el primero.
const sinTildes = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function quitarDuplicados(avisos, previos = []) {
  const claveDe = a => a.direccion && a.precio ? `${sinTildes(a.direccion).replace(/[^a-z0-9]+/g, " ").trim()}|${a.precio}|${a.moneda}` : null;
  const vistas = new Set(previos.map(claveDe).filter(Boolean));
  return avisos.filter(a => {
    const k = claveDe(a);
    if (!k) return true;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

const normalizarAvisosCantidad = lista => (Array.isArray(lista) ? lista.length : 0);

// ── Estadísticas ─────────────────────────────────────────────

function percentil(ordenado, p) {
  if (!ordenado.length) return null;
  const idx = (ordenado.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(ordenado[lo] + (ordenado[hi] - ordenado[lo]) * (idx - lo));
}

// Medidas de una lista de valores ya ordenada de menor a mayor
function medidas(vals) {
  return {
    mediana: percentil(vals, 0.5),
    promedio: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
    p25: percentil(vals, 0.25),
    p75: percentil(vals, 0.75),
    min: vals[0],
    max: vals[vals.length - 1],
  };
}

// Dos juegos de estadísticas:
//  - USD/m² (claves *_usd_m2): solo avisos en dólares con superficie calculable (ver superficieBase)
//  - precio publicado (estadisticas.precio): todos los avisos con precio en dólares, tengan o no superficie
// Los avisos marcados como atípicos por su USD/m² (muy fuera de la zona) quedan fuera de ambos.
// Un aviso entra en las estadísticas si no se verificó nada (búsquedas viejas) o si su link se verificó bien
const entraEnEstadisticas = a => !a.verificacion || a.verificacion.estado === "verificado" || a.confirmado_a_mano === true;

function calcularEstadisticas(avisos) {
  avisos.forEach(a => { a.atipico = false; });
  const validos = avisos.filter(a => a.usd_m2 && entraEnEstadisticas(a));

  let usados = [];
  if (validos.length) {
    // Atípicos: menos de la mitad o más de 1,8 veces la mediana inicial
    const inicial = validos.map(a => a.usd_m2).sort((x, y) => x - y);
    const medIni = percentil(inicial, 0.5);
    for (const a of validos) a.atipico = a.usd_m2 < medIni * 0.5 || a.usd_m2 > medIni * 1.8;

    usados = validos.filter(a => !a.atipico);
    if (usados.length < 3) {
      // Con muy pocos datos no descartamos nada
      validos.forEach(a => { a.atipico = false; });
      usados = validos;
    }
  }

  const precios = avisos
    .filter(a => a.precio && a.moneda === "USD" && !a.atipico && entraEnEstadisticas(a))
    .map(a => a.precio)
    .sort((x, y) => x - y);

  if (!usados.length && !precios.length) return null;

  const vals = usados.map(a => a.usd_m2).sort((x, y) => x - y);
  const m = vals.length ? medidas(vals) : null;
  const mp = precios.length ? medidas(precios) : null;
  return {
    cantidad_usada: usados.length,
    cantidad_total: avisos.length,
    excluidos_atipicos: validos.length - usados.length,
    mediana_usd_m2: m ? m.mediana : null,
    promedio_usd_m2: m ? m.promedio : null,
    p25_usd_m2: m ? m.p25 : null,
    p75_usd_m2: m ? m.p75 : null,
    min_usd_m2: m ? m.min : null,
    max_usd_m2: m ? m.max : null,
    precio: mp
      ? {
          cantidad_usada: precios.length,
          mediana: mp.mediana, promedio: mp.promedio, p25: mp.p25, p75: mp.p75, min: mp.min, max: mp.max,
        }
      : null,
  };
}

// ── Geocodificación (Nominatim / OpenStreetMap) ──────────────

function distanciaKm(a, b) {
  const R = 6371;
  const rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function coordValida(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat < -20 && lat > -56 && lng < -53 && lng > -74;
}

// "La Pista al 1200" → "La Pista 1200"
function limpiarDireccion(d) {
  return String(d || "").replace(/\s+al\s+(\d+)/i, " $1").trim();
}

// exacta: llegó a número de puerta · calle: llegó a la calle · zona: barrio o localidad
function precisionDe(r) {
  const dir = r?.address || {};
  if (dir.house_number || r?.addresstype === "house" || r?.addresstype === "building") return "exacta";
  if (dir.road && (r?.class === "highway" || r?.addresstype === "road")) return "calle";
  return "zona";
}

// Candidatos de consulta, del más preciso al menos preciso. En barrios privados, OpenStreetMap suele no tener
// ni la calle ni el barrio, por eso se prueba también sin el barrio y, al final, solo con la localidad.
function candidatosGeo(item) {
  const zona = aTexto(item.zona, 100);
  const localidad = aTexto(item.localidad, 80);
  const barrio = aTexto(item.barrio, 100);
  const direccion = aTexto(limpiarDireccion(item.direccion), 120);
  const barrioCorto = barrio ? barrio.replace(/^(barrio\s+)?(privado|cerrado|abierto)\s+/i, "").replace(/^barrio\s+/i, "").trim() : null;
  const unir = (...p) => [...new Set(p.filter(Boolean))].join(", ");
  const out = [];
  if (direccion) {
    out.push(unir(direccion, barrio, localidad || zona, "Argentina"));
    out.push(unir(direccion, localidad || zona, "Argentina"));
  }
  if (barrio) out.push(unir(barrio, localidad || zona, "Argentina"));
  if (barrioCorto && barrioCorto !== barrio) out.push(unir(barrioCorto, localidad || zona, "Argentina"));
  if (localidad) out.push(unir(localidad, "Argentina"));
  if (zona) out.push(unir(zona, "Argentina"));
  return [...new Set(out)];
}

function crearGeocoder() {
  const cache = new Map();
  let ultima = 0;
  let cola = Promise.resolve();

  // Política de Nominatim: como máximo 1 consulta por segundo
  function turno() {
    const p = cola.then(async () => {
      const espera = Math.max(0, ultima + 1100 - Date.now());
      if (espera) await new Promise(r => setTimeout(r, espera));
      ultima = Date.now();
    });
    cola = p.catch(() => {});
    return p;
  }

  async function consultar(q, centro) {
    const clave = centro ? `${q}|${centro.lat.toFixed(1)},${centro.lng.toFixed(1)}` : q;
    if (cache.has(clave)) return cache.get(clave);

    await turno();
    const params = new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1", countrycodes: "ar" });
    if (centro) {
      const d = 0.4; // orienta el resultado hacia la zona (no lo limita)
      params.set("viewbox", `${centro.lng - d},${centro.lat + d},${centro.lng + d},${centro.lat - d}`);
    }
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": GEOCODER_UA, "Accept-Language": "es" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const arr = await res.json();
    const r = Array.isArray(arr) && arr[0] ? arr[0] : null;

    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(clave, r);
    return r;
  }

  async function ubicar(item, centro) {
    const candidatos = candidatosGeo(item);
    for (let i = 0; i < candidatos.length; i++) {
      const r = await consultar(candidatos[i], centro);
      if (!r) continue;
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      if (!coordValida(lat, lng)) continue;
      if (centro && distanciaKm(centro, { lat, lng }) > MAX_DISTANCIA_GEO_KM) continue;
      // Si la consulta no incluía la dirección, aunque el resultado sea una calle lo tratamos como zona
      const dirLimpia = aTexto(limpiarDireccion(item.direccion), 120);
      const precision = dirLimpia && candidatos[i].startsWith(dirLimpia) ? precisionDe(r) : "zona";
      return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), precision, fuente: "osm" };
    }
    return null;
  }

  return { ubicar };
}

// ── Verificación de links ────────────────────────────────────
// Para cada aviso se abre su link desde el servidor (no gasta tokens) y se comprueba que:
//  1) la página carga y es un aviso individual, no un listado ni la portada del sitio;
//  2) el precio publicado y al menos otro dato (superficie, dirección o barrio) se ven en esa página.
// De paso se leen las coordenadas y la dirección de la página, si las trae (JSON-LD, metadatos o mapa).
// No se intenta saltear bloqueos: si el portal bloquea la consulta, el aviso queda como no verificable.

function esIpPrivada(ip) {
  const l = String(ip).toLowerCase();
  if (net.isIPv4(l)) return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(l);
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") ||
    (l.startsWith("::ffff:") && esIpPrivada(l.slice(7)));
}

async function hostSeguro(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const ips = net.isIP(host) ? [{ address: host }] : await dnsP.lookup(host, { all: true }).catch(() => []);
  return ips.length > 0 && ips.every(x => !esIpPrivada(x.address));
}

async function leerLimitado(res, maxBytes) {
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const partes = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      partes.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* ya terminó */ }
    return Buffer.concat(partes.map(v => Buffer.from(v))).toString("utf8").slice(0, maxBytes);
  }
  return (await res.text()).slice(0, maxBytes);
}

// Baja la página siguiendo redirecciones a mano (hasta 5), revisando cada destino
async function bajarPagina(url) {
  let actual = url;
  for (let salto = 0; salto < 5; salto++) {
    if (!(await hostSeguro(actual))) return { error: "host_no_permitido" };
    let res;
    try {
      res = await fetch(actual, {
        redirect: "manual",
        signal: AbortSignal.timeout(VERIF_TIMEOUT_MS),
        headers: { "User-Agent": VERIF_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-AR,es;q=0.9" },
      });
    } catch (e) {
      return { error: e?.name === "TimeoutError" ? "timeout" : "conexion" };
    }
    const destino = res.headers?.get?.("location");
    if (res.status >= 300 && res.status < 400 && destino) {
      try { actual = new URL(destino, actual).toString(); } catch { return { error: "redireccion_invalida" }; }
      continue;
    }
    if (!res.ok) return { status: res.status, url: actual };
    const tipo = res.headers?.get?.("content-type") || "";
    if (tipo && !/html|xml|json/i.test(tipo)) return { status: res.status, url: actual, error: "no_html" };
    try {
      return { status: res.status, url: actual, html: await leerLimitado(res, VERIF_MAX_BYTES) };
    } catch {
      return { error: "conexion" };
    }
  }
  return { error: "demasiadas_redirecciones" };
}

// Entidades HTML: con nombre (&ntilde;), decimales (&#241;) y hexadecimales (&#xF1;, que usa Argenprop en la ficha)
const ENTIDADES = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", ordm: "º", ordf: "ª", sup2: "²", sup3: "³", deg: "°", middot: "·",
  iexcl: "¡", iquest: "¿", ntilde: "ñ", Ntilde: "Ñ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", uuml: "ü", Uuml: "Ü", ccedil: "ç", euro: "€",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
};
function decodificar(t) {
  return String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (n === 160) return " ";
      try { return String.fromCodePoint(n); } catch { return " "; }
    }
    return Object.prototype.hasOwnProperty.call(ENTIDADES, e) ? ENTIDADES[e] : m;
  });
}

// Texto de la página: lo visible más los datos estructurados (JSON-LD y __NEXT_DATA__) que traiga
function htmlATexto(html) {
  const h = String(html || "");
  const datos = [];
  for (const m of h.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) datos.push(m[1]);
  const visible = h
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodificar(visible + " " + datos.join(" ")).replace(/\s+/g, " ");
}

// Todos los números que aparecen en el texto, en sus lecturas posibles ("250.000" → 250000; "85,5" → 85.5)
function numerosDe(texto) {
  const exactos = new Set();
  const redondeados = new Set();
  for (const m of String(texto).matchAll(/\d{1,3}(?:[.,\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?/g)) {
    const tok = m[0];
    const entero = Number(tok.replace(/[.,\u00a0]/g, ""));
    if (Number.isFinite(entero)) { exactos.add(entero); redondeados.add(Math.round(entero)); }
    const dec = tok.match(/^(\d{1,3}(?:[.,\u00a0]\d{3})*|\d+)[.,](\d{1,2})$/);
    if (dec) {
      const v = Number(dec[1].replace(/[.,\u00a0]/g, "") + "." + dec[2]);
      if (Number.isFinite(v)) { exactos.add(v); redondeados.add(Math.round(v)); }
    }
  }
  return { exactos, redondeados };
}

function pareceListado(urlFinal, html, texto) {
  let u;
  try { u = new URL(urlFinal); } catch { return null; }
  const ruta = u.pathname.toLowerCase();
  const tieneId = /\d{5,}/.test(ruta) || /\d{5,}/.test(u.search);
  if (ruta.replace(/\//g, "") === "") return "el link lleva a la portada del sitio";
  if (/\/(casas?|departamentos?|inmuebles?|propiedades|terrenos?|lotes?|ph|locales?|oficinas?|emprendimientos)\/(venta|alquiler|comprar)(\/|$)/.test(ruta) && !tieneId) {
    return "el link lleva a una página de resultados, no a un aviso";
  }
  if (/"@type"\s*:\s*"(ItemList|CollectionPage|SearchResultsPage)"/i.test(html)) return "el link lleva a un listado";
  const precios = new Set();
  for (const m of texto.matchAll(/(?:USD|U\$S|US\$|\$)\s?(\d{1,3}(?:[.,]\d{3})+)/g)) precios.add(m[1]);
  if (precios.size > 14) return "el link lleva a un listado con muchos avisos";
  return null;
}

const BLOQUEO_RE = /just a moment|cf-chl|captcha|access denied|are you a robot|attention required|acceso denegado|verificando que eres/i;

function fmtPrecio(a) {
  return (a.moneda === "ARS" ? "$ " : "USD ") + Math.round(a.precio).toLocaleString("es-AR");
}

// Compara los datos del aviso con lo que muestra la página
function evaluarDatos(a, texto, nums) {
  const precio = a.precio ? nums.exactos.has(Math.round(a.precio)) : null;
  const objetivos = [a.m2_cubiertos, a.m2_totales, a.m2_terreno].filter(v => v > 0);
  const sup = objetivos.length ? objetivos.some(v => nums.redondeados.has(Math.round(v))) : null;
  const norm = sinTildes(texto);
  const todosEstan = t => {
    const toks = sinTildes(t).replace(/[^a-z0-9ñ ]+/g, " ").split(" ").filter(x => x.length >= 3 || /^\d+$/.test(x));
    return toks.length > 0 && toks.every(x => norm.includes(x));
  };
  const dir = a.direccion ? todosEstan(a.direccion) : null;
  const barrioTxt = a.barrio ? String(a.barrio).replace(/^(barrio\s+)?(privado|cerrado|abierto)\s+/i, "").replace(/^barrio\s+/i, "") : null;
  const barrio = barrioTxt ? todosEstan(barrioTxt) : null;
  return { precio, sup, dir, barrio };
}

const ARG_LAT = [-56, -21];
const ARG_LNG = [-74, -53];
const enArgentina = (lat, lng) => lat >= ARG_LAT[0] && lat <= ARG_LAT[1] && lng >= ARG_LNG[0] && lng <= ARG_LNG[1];

// Coordenadas, dirección y precio que la propia página declara
function extraerDePagina(html) {
  const out = { lat: null, lng: null, direccion: null, localidad: null, region: null, precio: null, moneda: null, titulo: null, tituloMeta: null, m2_totales: null, ambientes: null, dormitorios: null, banos: null, origen: null, conAltura: false };
  const h = String(html || "");
  const aNum = v => { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
  const fijar = (lat, lng, origen) => {
    const la = aNum(lat), lo = aNum(lng);
    if (la != null && lo != null && enArgentina(la, lo) && out.lat == null) { out.lat = la; out.lng = lo; out.origen = origen; }
  };

  // 1) JSON-LD
  const recorrer = (nodo, prof = 0) => {
    if (!nodo || typeof nodo !== "object" || prof > 8) return;
    if (Array.isArray(nodo)) { nodo.forEach(x => recorrer(x, prof + 1)); return; }
    if (nodo.geo && typeof nodo.geo === "object") fijar(nodo.geo.latitude, nodo.geo.longitude, "json-ld");
    if (nodo.latitude != null && nodo.longitude != null) fijar(nodo.latitude, nodo.longitude, "json-ld");
    if (nodo.address && typeof nodo.address === "object") {
      // streetAddress a veces trae el título del aviso: solo se guarda si es una calle con su altura
      if (nodo.address.streetAddress && !out.direccion && pareceDireccion(nodo.address.streetAddress)) out.direccion = aTexto(nodo.address.streetAddress, 120);
      if (nodo.address.addressLocality && !out.localidad) out.localidad = limpiarLocalidad(nodo.address.addressLocality);
      if (nodo.address.addressRegion && !out.region) out.region = limpiarLocalidad(nodo.address.addressRegion);
    }
    if (nodo.price != null && out.precio == null) {
      out.precio = aNum(nodo.price);
      const mon = String(nodo.priceCurrency || "").toUpperCase();
      if (mon === "USD" || mon === "ARS") out.moneda = mon;
    }
    if (nodo.floorSize && typeof nodo.floorSize === "object" && out.m2_totales == null) out.m2_totales = aNum(nodo.floorSize.value);
    if (nodo.numberOfRooms != null && out.ambientes == null) out.ambientes = aNum(nodo.numberOfRooms);
    if (nodo.numberOfBedrooms != null && out.dormitorios == null) out.dormitorios = aNum(nodo.numberOfBedrooms);
    if (nodo.numberOfBathroomsTotal != null && out.banos == null) out.banos = aNum(nodo.numberOfBathroomsTotal);
    if (nodo.name && !out.titulo && /house|apartment|residence|product|realestate|accommodation/i.test(String(nodo["@type"] || ""))) out.titulo = aTexto(limpiarTituloPagina(nodo.name), 200);
    for (const k of Object.keys(nodo)) if (typeof nodo[k] === "object") recorrer(nodo[k], prof + 1);
  };
  for (const m of h.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { recorrer(JSON.parse(m[1].trim())); } catch { /* JSON-LD mal formado: se ignora */ }
  }

  // 2) Metadatos
  if (out.lat == null) {
    const metas = {};
    for (const m of h.matchAll(/<meta\s+[^>]*>/gi)) {
      const k = m[0].match(/(?:property|name)=["']([^"']+)["']/i);
      const v = m[0].match(/content=["']([^"']*)["']/i);
      if (k && v) metas[k[1].toLowerCase()] = v[1];
    }
    fijar(metas["place:location:latitude"] ?? metas["og:latitude"] ?? metas["latitude"], metas["place:location:longitude"] ?? metas["og:longitude"] ?? metas["longitude"], "meta");
    const par = metas["geo.position"] || metas["icbm"];
    if (out.lat == null && par) { const [a, b] = par.split(/[;,]/); fijar(a, b, "meta"); }
  }

  // 3) Mapa incrustado o datos de la página (menos confiable: puede ser la oficina de la inmobiliaria)
  if (out.lat == null) {
    const patrones = [
      /"(?:latitude|lat|latitud)"\s*:\s*"?(-?\d{1,2}\.\d{3,})"?[\s\S]{0,60}?"(?:longitude|lng|lon|long|longitud)"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?/i,
      /(?:center|[?&]q|[?&]ll|destination)=(-?\d{1,2}\.\d{3,})(?:,|%2C)(-?\d{1,3}\.\d{3,})/i,
      /@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/,
      /data-lat(?:itude)?=["'](-?\d+\.\d+)["'][^>]*data-l(?:ng|on|ong|ongitude)=["'](-?\d+\.\d+)["']/i,
    ];
    for (const re of patrones) {
      const m = h.match(re);
      if (m) fijar(m[1], m[2], "mapa");
      if (out.lat != null) break;
    }
  }
  // Zonaprop informa el barrio en la región y el partido en la localidad: "Ingeniero Maschwitz, Escobar"
  if (out.region && out.localidad && !sinTildes(out.localidad).includes(sinTildes(out.region))) out.localidad = `${out.region}, ${out.localidad}`;
  else if (out.region && !out.localidad) out.localidad = out.region;
  out.conAltura = !!(out.direccion && /\d/.test(out.direccion));

  // Título de la página (og:title o <title>), sin el nombre del sitio al final
  let tm = null;
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    if (/property\s*=\s*["']og:title["']/i.test(m[0])) {
      const c = m[0].match(/content\s*=\s*["']([^"']*)["']/i);
      if (c) { tm = c[1]; break; }
    }
  }
  if (!tm) { const t = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) tm = t[1]; }
  if (tm) {
    out.tituloMeta = aTexto(limpiarTituloPagina(tm), 200);
  }
  return out;
}

// "85,5" → 85.5; "1.250" → 1250
function aM2(tok) {
  const t = String(tok).trim();
  const n = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(t) ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Superficies que la página muestra con su rótulo ("Superficie cubierta: 150 m²", "150 m² cubiertos").
// Solo se toma un dato si el rótulo es claro; la primera aparición es la del aviso (después suelen venir los relacionados).
function superficiesDeTexto(texto) {
  const t = sinTildes(texto);
  const N = "(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)";
  const U = "\\s*(?:m2|m²|mts2|mts|metros)";
  const rot = {
    m2_cubiertos: "(?<!semi)(?<!semi )cubiert[ao]s?",
    m2_semicubiertos: "semi\\s?cubiert[ao]s?",
    m2_descubiertos: "descubiert[ao]s?",
    m2_balcon: "balcon(?:es)?",
    m2_terreno: "(?:terreno|lote)",
    m2_totales: "(?:total|totales)",
  };
  const out = {};
  for (const [campo, r] of Object.entries(rot)) {
    const delante = new RegExp(`(?:sup(?:erficie)?\\.?\\s*)?${r}\\s*[:\\-]?\\s*${N}${U}`, "i");
    const detras = new RegExp(`${N}${U}\\s*(?:de\\s*)?${r}`, "i");
    const m = t.match(delante) || t.match(detras);
    if (m) {
      const v = aM2(m[1]);
      if (v != null && v < 100000) out[campo] = v;
    }
  }
  return out;
}

// ── Ficha del aviso, leída por portal ────────────────────────
// Cada portal muestra los datos con sus propios rótulos. Se leen por rótulo (nunca por un número suelto) y solo dentro
// del bloque del aviso, para no tomar datos de los avisos relacionados que vienen más abajo en la misma página.
// Lo que el aviso no publica queda vacío: no se deduce ni se completa con otra fuente.
// Cada dato sale con la cita textual de la página, para que se pueda comparar a ojo.

const ORIENTACIONES = { n: "Norte", s: "Sur", e: "Este", o: "Oeste", ne: "Noreste", no: "Noroeste", se: "Sudeste", so: "Sudoeste" };
// Datos de la ficha que se guardan en el aviso (los m² tienen sus propios campos)
const CAMPOS_FICHA = ["dormitorios", "banos", "ambientes", "estacionamiento", "antiguedad", "condicion", "orientacion", "disposicion", "expensas"];

// Una calle con su altura ("Víctor Casteran 1500", "La Pista al 1200"), no el título de un aviso
function pareceDireccion(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length < 5 || t.length > 70) return false;
  if (/\b(venta|alquiler|casa|casas|departamento|depto|lote|terreno|barrio|country|oportunidad|ambientes?|dormitorios?|m2|m²|usd|u\$s)\b/i.test(t)) return false;
  return /^[\p{L}0-9.°ºª'’ -]{3,50}\s(?:al\s)?\d{2,5}\b/iu.test(t);
}

// "Escobar, GBA Norte, Argentina," → "Escobar"
function limpiarLocalidad(s) {
  const partes = String(s || "").split(",").map(x => x.trim())
    .filter(x => x && !/^(argentina|gba\s*(norte|sur|oeste)|g\.?b\.?a\.?.*|bs\.?\s?as\.?.*|buenos aires)$/i.test(x));
  return aTexto(partes.join(", "), 80);
}

// Título de la página sin el nombre del sitio al final ("... - Argenprop", "... | MercadoLibre")
function limpiarTituloPagina(t) {
  const completo = decodificar(String(t || "")).replace(/\s+/g, " ").trim();
  const corto = completo.replace(/\s+[|–—]\s+[^|–—]{1,30}$/, "").replace(/\s+-\s+[^-]{1,24}$/, "").trim();
  return corto.length >= 8 ? corto : completo;
}

const monedaDe = s => (/^\$$/.test(String(s).trim()) ? "ARS" : "USD");
const montoDe = s => Number(String(s).replace(/[.,]/g, ""));
const antiguedadDe = n => (n === 0 ? "A estrenar" : `${n} ${n === 1 ? "año" : "años"}`);
const orientacionDe = s => ORIENTACIONES[sinTildes(s).replace(/[^a-z]/g, "")] || aTexto(s, 30);

// Lee la ficha de un aviso. html puede ser null (texto pegado por el usuario); urlFinal puede ser null:
// sin portal conocido se prueban los tres juegos de rótulos y se toma lo que cada uno encuentre.
// Devuelve { portal, campos, superficies, precio, ubicacion, evidencia }
function leerFicha(html, texto, urlFinal) {
  const R = { portal: null, campos: {}, superficies: {}, precio: null, ubicacion: {}, evidencia: [] };
  const t = String(texto || "");
  let host = "";
  try { host = new URL(urlFinal).hostname.replace(/^www\./, ""); } catch { /* sin link: texto pegado */ }
  const esArg = /argenprop\./i.test(host), esZona = /zonaprop\./i.test(host), esML = /mercadolibre\.|mercadolivre\./i.test(host);
  const todos = !esArg && !esZona && !esML;

  const cita = frag => String(frag).replace(/\s+/g, " ").trim().slice(0, 90);
  const tomar = (campo, valor, frag) => {
    if (valor == null || valor === "" || (typeof valor === "number" && !Number.isFinite(valor))) return;
    if (R.campos[campo] != null) return;
    R.campos[campo] = valor;
    if (frag) R.evidencia.push({ campo, texto: cita(frag) });
  };
  const tomarSup = (campo, valor, frag) => {
    if (valor == null || !Number.isFinite(valor) || valor < 0 || valor >= 100000) return;
    if (R.superficies[campo] != null) return;
    R.superficies[campo] = valor;
    if (frag) R.evidencia.push({ campo, texto: cita(frag) });
  };
  const enBloque = (bloque, re, campo, fn) => { const m = bloque.match(re); if (m) tomar(campo, fn(m[1]), m[0]); return m; };

  // ── Argenprop: bloque oculto de la ficha y lista "Características"
  if (esArg || todos) {
    const ga = html ? String(html).match(/<[^>]*id=["']ga-dimension-ficha["'][^>]*>/i) : null;
    const d = {};
    if (ga) for (const m of ga[0].matchAll(/data-([a-z-]+)=["']([^"']*)["']/gi)) d[m[1]] = decodificar(m[2]).trim();
    const p = Number(d.price);
    if (p > 0 && (d.moneda === "USD" || d.moneda === "ARS")) { R.portal = "argenprop"; R.precio = { valor: p, moneda: d.moneda }; }
    if (!R.precio) {
      const mp = t.match(/Precio:\s*(USD|U\$S|US\$|\$)\s?(\d{1,3}(?:[.,]\d{3})+)(?![\d.,])/i);
      if (mp && (esArg || /C[oó]digo de aviso|Tipo de operaci[oó]n/i.test(t))) { R.portal = "argenprop"; R.precio = { valor: montoDe(mp[2]), moneda: monedaDe(mp[1]) }; }
    }
    const iCar = t.search(/Caracter[íi]sticas\s+(?:Antig[uü]edad|Cant\.|Estado|Long\.|Expensas|Orientaci)/i);
    if (iCar >= 0) {
      R.portal = "argenprop";
      const resto = t.slice(iCar);
      const fin = resto.search(/C[oó]digo de aviso|similares|Contact[aá] al anunciante/i);
      const bloque = resto.slice(0, fin > 0 ? Math.min(fin, 1800) : 1800);
      // Superficies de la ficha ("Sup. Cubierta: 145 m2")
      const supA = (re, campo) => { const m = bloque.match(re); if (m) tomarSup(campo, aM2(m[1]), m[0]); };
      supA(/Sup\.\s*Cubierta:\s*(\d[\d.,]*)\s*m2/i, "m2_cubiertos");
      supA(/Sup\.\s*Semicubierta:\s*(\d[\d.,]*)\s*m2/i, "m2_semicubiertos");
      supA(/Sup\.\s*Descubierta:\s*(\d[\d.,]*)\s*m2/i, "m2_descubiertos");
      supA(/Sup\.\s*Terreno:\s*(\d[\d.,]*)\s*m2/i, "m2_terreno");
      supA(/Sup\.\s*Total:\s*(\d[\d.,]*)\s*m2/i, "m2_totales");
      enBloque(bloque, /Antig[uü]edad:\s*(\d+)/i, "antiguedad", v => antiguedadDe(Number(v)));
      enBloque(bloque, /Cant\.\s*Ba[ñn]os:\s*(\d+)/i, "banos", Number);
      enBloque(bloque, /Cant\.\s*Dormitorios:\s*(\d+)/i, "dormitorios", Number);
      enBloque(bloque, /Cant\.\s*Ambientes:\s*(\d+)/i, "ambientes", Number);
      enBloque(bloque, /Cant\.\s*Cocheras:\s*(\d+)/i, "estacionamiento", Number);
      enBloque(bloque, /Estado:\s*([^:]{2,30}?)\s+(?=Cant\.|Long\.|Expensas|Orientaci|Disposici|Datos b|Antig|$)/i, "condicion", v => aTexto(v, 40));
      enBloque(bloque, /Orientaci[oó]n:\s*([A-Za-zÁ-ú]{1,12})/i, "orientacion", orientacionDe);
      enBloque(bloque, /Disposici[oó]n:\s*([A-Za-zÁ-ú]{3,20})/i, "disposicion", v => aTexto(v, 30));
      const me = bloque.match(/Expensas:\s*(\$|USD|U\$S|US\$)\s*(\d{1,3}(?:[.,]\d{3})*)/i);
      if (me) tomar("expensas", { monto: montoDe(me[2]), moneda: monedaDe(me[1]) }, me[0]);
      // "A estrenar" aparece en la lista principal, justo antes de "Características"
      if (R.campos.antiguedad == null && /(?:^|\s)A estrenar(?:\s|$)/i.test(t.slice(Math.max(0, iCar - 900), iCar))) tomar("antiguedad", "A estrenar", "A estrenar");
    }
    if (d.dormitorios != null && d.dormitorios !== "" && Number.isFinite(Number(d.dormitorios))) tomar("dormitorios", Number(d.dormitorios), `ficha: ${d.dormitorios} dormitorios`);
    if (R.portal === "argenprop" || esArg) {
      const loc = [d.localidad, d.partido].map(x => (x || "").trim()).filter(Boolean).join(", ");
      if (loc) R.ubicacion.localidad = aTexto(loc, 80);
      if (d.barrio) R.ubicacion.barrio = aTexto(d.barrio, 60);
    }
  }

  // ── Zonaprop: tira de iconos con abreviaturas ("244 m² cub. 6 amb. 3 baños 1 coch. 3 dorm. 50 años")
  if (esZona || todos) {
    const i = t.search(/\d[\d.,]*\s*m²\s*(?:tot|cub|desc|semi)\./i);
    if (i >= 0) {
      R.portal = "zonaprop";
      let tira = t.slice(i, i + 320);
      const k = tira.search(/Ver m[aá]s/i);
      if (k > 0) tira = tira.slice(0, k);
      const sup = (re, campo) => { const m = tira.match(re); if (m) tomarSup(campo, aM2(m[1]), m[0]); };
      sup(/(\d[\d.,]*)\s*m²\s*tot\./i, "m2_totales");
      sup(/(\d[\d.,]*)\s*m²\s*cub\./i, "m2_cubiertos");
      sup(/(\d[\d.,]*)\s*m²\s*semi\w*\./i, "m2_semicubiertos");
      sup(/(\d[\d.,]*)\s*m²\s*desc\w*\./i, "m2_descubiertos");
      enBloque(tira, /(\d+)\s*amb\./i, "ambientes", Number);
      enBloque(tira, /(\d+)\s*ba[ñn]os?\b/i, "banos", Number);
      enBloque(tira, /(\d+)\s*coch\./i, "estacionamiento", Number);
      enBloque(tira, /(\d+)\s*dorm\./i, "dormitorios", Number);
      const ma = tira.match(/(\d+)\s*a[ñn]os\b/i);
      if (ma) tomar("antiguedad", antiguedadDe(Number(ma[1])), ma[0]);
      else if (/\bA estrenar\b/i.test(tira)) tomar("antiguedad", "A estrenar", "A estrenar");
      // El precio de la propia ficha va justo antes de la tira ("... venta USD 269.000 ...")
      if (!R.precio) {
        const mp = t.slice(Math.max(0, i - 400), i).match(/(?:venta|alquiler)\s+(USD|U\$S|US\$|\$)\s?(\d{1,3}(?:[.,]\d{3})+)(?![\d.,])/i);
        if (mp) R.precio = { valor: montoDe(mp[2]), moneda: monedaDe(mp[1]) };
      }
    }
  }

  // ── MercadoLibre: bloque "Principales" (rótulo + valor)
  if (esML || todos) {
    const i = t.search(/Principales\s+Superficie\s+(?:total|cubierta)/i);
    if (i >= 0) {
      R.portal = "mercadolibre";
      const bloque = t.slice(i, i + 700);
      const sup = (re, campo) => { const m = bloque.match(re); if (m) tomarSup(campo, aM2(m[1]), m[0]); };
      sup(/Superficie total\s+(\d[\d.,]*)\s*m²/i, "m2_totales");
      sup(/Superficie cubierta\s+(\d[\d.,]*)\s*m²/i, "m2_cubiertos");
      sup(/Superficie semicubierta\s+(\d[\d.,]*)\s*m²/i, "m2_semicubiertos");
      sup(/Superficie descubierta\s+(\d[\d.,]*)\s*m²/i, "m2_descubiertos");
      sup(/Superficie (?:de|del) terreno\s+(\d[\d.,]*)\s*m²/i, "m2_terreno");
      enBloque(bloque, /Dormitorios\s+(\d+)/i, "dormitorios", Number);
      enBloque(bloque, /Ba[ñn]os\s+(\d+)/i, "banos", Number);
      enBloque(bloque, /Cocheras\s+(\d+)/i, "estacionamiento", Number);
      enBloque(bloque, /Ambientes\s+(\d+)/i, "ambientes", Number);
      enBloque(bloque, /Antig[uü]edad\s+(\d+)\s*a[ñn]os?/i, "antiguedad", v => antiguedadDe(Number(v)));
      enBloque(bloque, /Orientaci[oó]n\s+([A-Za-zÁ-ú]{1,12})/i, "orientacion", orientacionDe);
      const me = bloque.match(/Expensas\s+(\d{1,3}(?:[.,]\d{3})*)\s*(ARS|USD)/i);
      if (me) tomar("expensas", { monto: montoDe(me[1]), moneda: me[2].toUpperCase() }, me[0]);
      if (!R.precio) {
        const mp = t.slice(0, i).match(/(USD|U\$S|US\$)\s?(\d{1,3}(?:[.,]\d{3})+)(?![\d.,])/i);
        if (mp) R.precio = { valor: montoDe(mp[2]), moneda: "USD" };
      }
      // Dirección: "Ubicación e información de la zona La Pista Al 1200, Escobar, Bs.As. G.B.A. Norte"
      const mu = t.match(/Ubicaci[oó]n e informaci[oó]n de la zona\s+(.{3,160}?),\s*Bs\.?\s?As\./i);
      if (mu) {
        const partes = mu[1].split(",").map(x => x.trim()).filter(Boolean);
        if (partes.length && pareceDireccion(partes[0])) R.ubicacion.direccion = aTexto(partes[0], 120);
        if (partes.length) R.ubicacion.localidad = aTexto(partes[partes.length - 1], 80);
      }
    }
  }
  return R;
}

// Ficha a partir de un texto pegado (sin HTML ni link). Solo toma lo que el texto dice con su rótulo.
function leerFichaDeTexto(texto) {
  return leerFicha(null, String(texto || "").replace(/\s+/g, " "), null);
}

const MOTIVOS_ERROR = {
  host_no_permitido: "el link apunta a una dirección que no se puede consultar",
  timeout: "el portal tardó demasiado en responder",
  conexion: "no se pudo conectar con el portal",
  redireccion_invalida: "el link redirige a una dirección inválida",
  demasiadas_redirecciones: "el link redirige demasiadas veces",
  no_html: "el link no lleva a una página web",
};

// Lee una página una sola vez por búsqueda (verificar avisos y expandir listados usan la misma lectura)
function leerPaginaUnaVez(url, cache) {
  const k = claveLink(url) || url;
  if (!cache.has(k)) cache.set(k, bajarPagina(url).catch(() => ({ error: "conexion" })));
  return cache.get(k);
}

// Algunos portales devuelven la portada (o una página genérica) para cualquier ruta, o arman el aviso con
// JavaScript: el servidor no ve el aviso. Se detecta porque la URL canónica de la página es la raíz del sitio.
function esPortadaDisfrazada(urlFinal, html) {
  let ruta;
  try { ruta = new URL(urlFinal).pathname.replace(/\/+$/, ""); } catch { return null; }
  if (ruta === "") return null; // la portada real ya la detecta pareceListado
  const h = String(html || "");
  let canonica = null;
  for (const m of h.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel\s*=\s*["']?canonical/i.test(m[0])) {
      const href = m[0].match(/href\s*=\s*["']([^"']+)["']/i);
      if (href) { canonica = href[1]; break; }
    }
  }
  if (!canonica) {
    for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
      if (/property\s*=\s*["']og:url["']/i.test(m[0])) {
        const c = m[0].match(/content\s*=\s*["']([^"']+)["']/i);
        if (c) { canonica = c[1]; break; }
      }
    }
  }
  if (!canonica) return null;
  try {
    if (new URL(canonica, urlFinal).pathname.replace(/\/+$/, "") === "") {
      return "la página que abre el link es la portada del sitio, no el aviso (el aviso no existe, se dio de baja o el portal lo arma con JavaScript)";
    }
  } catch { /* canónica inválida: se ignora */ }
  return null;
}

// Las distintas lecturas numéricas de un token ("250.000" → 250000; "85,5" → 85.5)
function lecturasDe(tok) {
  const out = [];
  const entero = Number(tok.replace(/[.,\u00a0]/g, ""));
  if (Number.isFinite(entero)) out.push(entero);
  const dec = tok.match(/^(\d{1,3}(?:[.,\u00a0]\d{3})*|\d+)[.,](\d{1,2})$/);
  if (dec) {
    const v = Number(dec[1].replace(/[.,\u00a0]/g, "") + "." + dec[2]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// Busca en el texto de la página un número y devuelve el fragmento textual donde aparece (o null).
//  moneda: el número tiene que ir junto a USD / U$S (o $) · unidad: seguido de m² · redondeo: acepta 85,5 por 86
function buscarNumero(texto, valor, { moneda = null, unidad = false, redondeo = false } = {}) {
  const re = /\d{1,3}(?:[.,\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(texto))) {
    const tok = m[0];
    const coincide = lecturasDe(tok).some(v => redondeo ? Math.round(v) === Math.round(valor) : v === valor);
    if (!coincide) continue;
    const antes = texto.slice(Math.max(0, m.index - 10), m.index);
    const despues = texto.slice(m.index + tok.length, m.index + tok.length + 12);
    if (moneda === "USD" && !(/(?:USD|U\$S|US\$|d[oó]lares?)\s*$/i.test(antes) || /^\s*(?:USD|U\$S|US\$|d[oó]lares?)/i.test(despues))) continue;
    if (moneda === "ARS" && !(/(?<![A-Za-z$])\$\s*$/.test(antes) || /^\s*(?:ARS|pesos)/i.test(despues))) continue;
    if (unidad && !/^\s*(?:m2|m²|mts2?|metros)/i.test(despues)) continue;
    // Fragmento corto y legible: hasta 3 palabras antes y 3 después del número
    const previas = texto.slice(Math.max(0, m.index - 60), m.index).trim().split(/\s+/).slice(-3).join(" ");
    const siguientes = texto.slice(m.index + tok.length, m.index + tok.length + 60).trim().split(/\s+/).slice(0, 3).join(" ");
    return [previas, tok, siguientes].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
  }
  return null;
}

// Precio de una página sin datos estructurados: solo se acepta si hay UN solo monto en toda la página
// (con avisos relacionados o expensas hay varios, y no se elige uno al azar).
function precioUnicoEnTexto(texto) {
  const usd = new Set();
  const ars = new Set();
  for (const m of texto.matchAll(/(?:USD|U\$S|US\$)\s?(\d{1,3}(?:[.,]\d{3})+)(?![\d.,])/gi)) usd.add(Number(m[1].replace(/[.,]/g, "")));
  for (const m of texto.matchAll(/(?<![A-Za-z$])\$\s?(\d{1,3}(?:[.,]\d{3})+)(?![\d.,])/g)) ars.add(Number(m[1].replace(/[.,]/g, "")));
  if (usd.size === 1 && ars.size === 0) return { valor: [...usd][0], moneda: "USD" };
  if (ars.size === 1 && usd.size === 0) return { valor: [...ars][0], moneda: "ARS" };
  return null;
}

// Tipo de inmueble tal como lo dice el título de la propia página
function tipoDeTitulo(titulo) {
  const m = sinTildes(titulo).match(/\b(casa quinta|casa|departamento|duplex|triplex|ph|chalet|lote|terreno|local|oficina|cochera|galpon|quinta)\b/);
  if (!m) return null;
  return m[1] === "ph" ? "PH" : m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

const CAMPOS_M2 = ["m2_cubiertos", "m2_semicubiertos", "m2_descubiertos", "m2_balcon", "m2_terreno", "m2_totales"];

// Contrasta lo que escribió el modelo con el texto de la página. Devuelve:
//  - evidencia: lo que la página dice textualmente (precio y superficies), para comparar a ojo
//  - anular: campos del modelo que la página NO confirma (se quitan: nunca se deja un dato sin respaldo)
//  - caracteristicas: solo las que la página menciona
function confirmarCampos(a, pagina, texto) {
  const pg = pagina || {};
  const norm = sinTildes(texto);
  const evidencia = [];
  const anular = [];

  const estructurado = pg.precio > 0 && (pg.moneda === "USD" || pg.moneda === "ARS");
  const precio = estructurado ? pg.precio : a.precio;
  const moneda = estructurado ? pg.moneda : a.moneda;
  if (precio) {
    const f = buscarNumero(texto, precio, { moneda });
    if (f) evidencia.push({ campo: "precio", texto: f });
    else if (estructurado) evidencia.push({ campo: "precio", texto: `dato declarado por la página: ${moneda} ${Math.round(precio).toLocaleString("es-AR")}` });
  }

  const sup = { ...(pg.m2_totales ? { m2_totales: pg.m2_totales } : {}), ...(pg.superficies || {}) };
  for (const c of CAMPOS_M2) {
    const delaPagina = sup[c] != null;
    const valor = delaPagina ? sup[c] : a[c];
    if (valor == null) continue;
    const f = valor > 0 ? buscarNumero(texto, valor, { unidad: true, redondeo: true }) : null;
    if (f) evidencia.push({ campo: c, texto: f });
    else if (!delaPagina) anular.push(c);
  }

  const tokens = t => sinTildes(t).replace(/[^a-z0-9ñ ]+/g, " ").split(" ").filter(x => x.length >= 3 || /^\d+$/.test(x));
  const todos = t => { const k = tokens(t); return k.length > 0 && k.every(x => norm.includes(x)); };
  const mitad = t => { const k = tokens(t); return k.length > 0 && k.filter(x => norm.includes(x)).length >= Math.ceil(k.length / 2); };
  if (a.direccion && !todos(a.direccion)) anular.push("direccion");
  if (a.barrio) {
    const b = String(a.barrio).replace(/^(barrio\s+)?(privado|cerrado|abierto)\s+/i, "").replace(/^barrio\s+/i, "");
    if (!todos(b)) anular.push("barrio");
  }
  if (a.localidad && !todos(a.localidad)) anular.push("localidad");
  if (a.ubicacion && !mitad(a.ubicacion)) anular.push("ubicacion");
  if (a.antiguedad && !norm.includes(sinTildes(a.antiguedad))) anular.push("antiguedad");
  if (a.tipo && !norm.includes(sinTildes(a.tipo))) anular.push("tipo");
  if (!pg.ambientes && a.ambientes && !new RegExp(`(?:^|[^0-9])${a.ambientes}\\s*(?:amb|ambientes)\\b`).test(norm)) anular.push("ambientes");
  const caracteristicas = (a.caracteristicas || []).filter(c => norm.includes(sinTildes(c)));
  // Citas de los datos de la ficha (dormitorios, baños, antigüedad, etc.); las superficies y el precio ya tienen la suya
  const yaTienen = new Set(evidencia.map(e => e.campo));
  for (const e of pg.ficha?.evidencia || []) {
    if (!yaTienen.has(e.campo)) { evidencia.push(e); yaTienen.add(e.campo); }
    else if (CAMPOS_M2.includes(e.campo)) evidencia[evidencia.findIndex(x => x.campo === e.campo)] = e; // la cita de la ficha es más precisa
  }
  return { evidencia, anular, caracteristicas };
}

// Links de avisos individuales que una página de listado trae en sus enlaces (mismo sitio, con el código del aviso en la ruta)
function extraerLinksDeAvisos(html, urlBase, max) {
  let base;
  try { base = new URL(urlBase); } catch { return []; }
  const host = base.hostname.replace(/^www\./, "");
  const propia = claveLink(urlBase);
  const vistos = new Set();
  const out = [];
  for (const m of String(html || "").matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let u;
    try { u = new URL(decodificar(m[1]).trim(), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
    const link = limpiarLink(u.toString());
    if (!link || !pareceUrlDeAviso(link)) continue;
    const k = claveLink(link);
    if (!k || k === propia || vistos.has(k)) continue;
    vistos.add(k);
    out.push(link);
    if (out.length >= max) break;
  }
  return out;
}

// Links de avisos que el servidor lee por su cuenta, además de los que escribió el modelo:
//  1) resultados de la búsqueda web que ya son un aviso individual
//  2) avisos que figuran como enlaces dentro de los listados que devolvió la búsqueda (se leen hasta MAX_LISTADOS_A_LEER)
// Todos salen de páginas reales; nada se arma a partir de un título.
async function candidatosDeResultados(resultados, yaTomadas, cache, cupo) {
  const claves = new Set(yaTomadas);
  const links = [];
  const agregar = link => {
    const k = claveLink(link);
    if (!k || claves.has(k) || links.length >= cupo) return false;
    claves.add(k);
    links.push(link);
    return true;
  };
  const listados = [];
  for (const r of resultados || []) {
    if (pareceUrlDeAviso(r.url)) agregar(r.url);
    else listados.push(r);
  }
  const leidas = await Promise.all(listados.slice(0, MAX_LISTADOS_A_LEER).map(async r => ({ r, pag: await leerPaginaUnaVez(r.url, cache) })));
  let listadosLeidos = 0;
  let linksEnListados = 0;
  const porListado = leidas.map(x => {
    if (!x.pag?.html) return [];
    listadosLeidos++;
    const ls = extraerLinksDeAvisos(x.pag.html, x.pag.url || x.r.url, MAX_LINKS_POR_LISTADO);
    linksEnListados += ls.length;
    return ls;
  });
  // De a uno por listado, para que un solo listado no se lleve todo el cupo
  for (let i = 0; i < MAX_LINKS_POR_LISTADO; i++) for (const ls of porListado) if (ls[i]) agregar(ls[i]);
  return { links, listados_leidos: listadosLeidos, links_en_listados: linksEnListados };
}

async function verificarAviso(a, cache = new Map()) {
  if (!a.link) return { estado: "sin_link", motivo: "no trae el link del aviso" };
  const r = await leerPaginaUnaVez(a.link, cache);
  if (r.error) return { estado: "inaccesible", motivo: MOTIVOS_ERROR[r.error] || "no se pudo abrir el link" };
  if (r.status === 404 || r.status === 410) return { estado: "inexistente", motivo: `el link no existe o el aviso se dio de baja (error ${r.status})` };
  if (!r.html) {
    const bloquea = [401, 403, 429, 503].includes(r.status);
    return { estado: "inaccesible", motivo: bloquea ? `el portal bloquea la verificación automática (error ${r.status})` : `el link responde con un error (${r.status})` };
  }
  const texto = htmlATexto(r.html);
  if (BLOQUEO_RE.test(texto.slice(0, 1500)) && texto.length < 6000) {
    return { estado: "inaccesible", motivo: "el portal pide comprobar que no sos un robot: no se puede verificar" };
  }
  const listado = pareceListado(r.url, r.html, texto);
  if (listado) return { estado: "listado", motivo: listado };
  const portada = esPortadaDisfrazada(r.url, r.html);
  if (portada) return { estado: "no_legible", motivo: portada };

  const pagina = extraerDePagina(r.html);
  // Ficha por portal (Argenprop, Zonaprop, MercadoLibre): precio, superficies y datos del aviso con su cita textual
  const ficha = leerFicha(r.html, texto, r.url);
  pagina.ficha = ficha;
  pagina.superficies = { ...superficiesDeTexto(texto), ...ficha.superficies };
  if (!(pagina.precio > 0) && ficha.precio) { pagina.precio = ficha.precio.valor; pagina.moneda = ficha.precio.moneda; }
  if (!pagina.direccion && ficha.ubicacion.direccion) { pagina.direccion = ficha.ubicacion.direccion; pagina.conAltura = /\d/.test(pagina.direccion); }
  if (ficha.ubicacion.localidad) pagina.localidad = ficha.ubicacion.localidad;
  if (ficha.ubicacion.barrio) pagina.barrio = ficha.ubicacion.barrio;
  // Si la página declara su precio de forma estructurada (JSON-LD) y no es un listado, el aviso existe y sus datos
  // salen de ahí, aunque el modelo los haya leído distinto.
  const precioEstructurado = pagina.precio > 0 && (pagina.moneda === "USD" || pagina.moneda === "ARS");

  if (a.solo_pagina) {
    // El modelo no escribió nada de este aviso: todo sale de la página, y el precio solo se acepta sin ambigüedad
    let precioOk = precioEstructurado;
    if (!precioOk) {
      const u = precioUnicoEnTexto(texto);
      if (u) { pagina.precio = u.valor; pagina.moneda = u.moneda; precioOk = true; }
    }
    if (!precioOk && !Object.keys(pagina.superficies).length) {
      return { estado: "no_legible", motivo: "no se pudo leer el precio ni la superficie de la página", pagina };
    }
    pagina.tipo = tipoDeTitulo(pagina.titulo || pagina.tituloMeta);
    return { estado: "verificado", motivo: null, pagina, urlFinal: r.url, confirmacion: confirmarCampos({ ...a, precio: null }, pagina, texto) };
  }

  const ev = evaluarDatos(a, texto, numerosDe(texto));
  const aciertos = [ev.sup, ev.dir, ev.barrio].filter(x => x === true).length;
  // El número del precio tiene que aparecer junto a la moneda que informó el modelo (USD vs pesos)
  const monedaOk = !a.precio || precioEstructurado || !!buscarNumero(texto, a.precio, { moneda: a.moneda });
  const ok = precioEstructurado || (a.precio ? ev.precio === true && monedaOk && aciertos >= 1 : aciertos >= 2);
  if (!ok) {
    const motivo = a.precio && ev.precio !== true
      ? `el precio publicado (${fmtPrecio(a)}) no se ve en la página del link`
      : a.precio && !monedaOk
        ? `el monto ${Math.round(a.precio).toLocaleString("es-AR")} aparece en la página pero no con la moneda informada (${a.moneda || "sin moneda"})`
        : "los datos del aviso (superficie, dirección) no se ven en la página del link";
    return { estado: "no_coincide", motivo, pagina };
  }
  return { estado: "verificado", motivo: null, pagina, urlFinal: r.url, confirmacion: confirmarCampos(a, pagina, texto) };
}

// Verifica todos los avisos con hasta 6 consultas en paralelo y un tope de tiempo total
async function verificarAvisos(avisos, cache = new Map()) {
  const limite = Date.now() + VERIF_PRESUPUESTO_MS;
  const res = new Array(avisos.length);
  let i = 0;
  async function trabajador() {
    for (;;) {
      const k = i++;
      if (k >= avisos.length) return;
      if (Date.now() > limite) { res[k] = { estado: "no_verificado", motivo: "se agotó el tiempo de verificación" }; continue; }
      try { res[k] = await verificarAviso(avisos[k], cache); }
      catch { res[k] = { estado: "inaccesible", motivo: "no se pudo abrir el link" }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VERIF_CONCURRENCIA, avisos.length) }, trabajador));
  return res;
}

// Guarda en el aviso el resultado de la verificación. Si el aviso se verificó, los datos que la propia página
// muestra (precio, superficies, ubicación) reemplazan a los del modelo, lo que la página no confirma se quita
// y se recalcula el USD/m². Devuelve el aviso (nuevo, ya recalculado).
function aplicarVerificacion(a, v, { releer = false } = {}) {
  const pg = v.pagina;
  const nuevo = { ...a, verificacion: { estado: v.estado, motivo: v.motivo || null } };
  const dePagina = [];
  if (v.estado === "verificado" && pg) {
    const conf = v.confirmacion;
    if (conf) {
      for (const c of conf.anular) nuevo[c] = null;
      nuevo.caracteristicas = conf.caracteristicas;
      if (conf.evidencia.length) nuevo.evidencia = conf.evidencia;
    }
    if (pg.precio > 0 && (pg.moneda === "USD" || pg.moneda === "ARS")) {
      if (nuevo.precio !== pg.precio || nuevo.moneda !== pg.moneda) dePagina.push("precio");
      nuevo.precio = pg.precio;
      nuevo.moneda = pg.moneda;
    }
    const sup = { ...(pg.m2_totales ? { m2_totales: pg.m2_totales } : {}), ...(pg.superficies || {}) };
    for (const [campo, valor] of Object.entries(sup)) {
      if (valor != null && nuevo[campo] !== valor) { nuevo[campo] = valor; dePagina.push(campo); }
    }
    if (!nuevo.ambientes && pg.ambientes) nuevo.ambientes = pg.ambientes;
    if (!nuevo.dormitorios && pg.dormitorios != null && !pg.ficha?.campos?.dormitorios) nuevo.dormitorios = pg.dormitorios;
    if (!nuevo.banos && pg.banos != null && !pg.ficha?.campos?.banos) nuevo.banos = pg.banos;
    const titulo = pg.titulo || pg.tituloMeta;
    if (titulo) nuevo.titulo = titulo;
    if (a.solo_pagina && pg.tipo) nuevo.tipo = pg.tipo;
    if (pg.lat != null && pg.lng != null) {
      nuevo.lat = pg.lat; nuevo.lng = pg.lng;
      nuevo.ubic_precision = pg.conAltura ? "exacta" : "calle";
      nuevo.ubic_origen = "pagina";
    }
    // Al leer de nuevo la página (o en avisos que el servidor leyó por su cuenta) lo que la página muestra pisa lo anterior;
    // en los que escribió el modelo solo se completa lo vacío
    const manda = a.solo_pagina || releer;
    if (pg.direccion && (manda || !nuevo.direccion)) nuevo.direccion = pg.direccion;
    if (pg.localidad && (manda || !nuevo.localidad)) nuevo.localidad = pg.localidad;
    if (pg.barrio && (manda || !nuevo.barrio)) nuevo.barrio = pg.barrio;

    // Datos de la ficha de cada portal, con su origen. Lo cargado a mano no se pisa.
    const origen = { ...(a.origen_campos || {}) };
    const fi = pg.ficha;
    if (fi) {
      for (const c of CAMPOS_FICHA) {
        if (fi.campos[c] == null || origen[c] === "manual") continue;
        nuevo[c] = fi.campos[c];
        origen[c] = "pagina";
      }
    }
    for (const c of ["precio", ...CAMPOS_M2, "direccion", "localidad", "barrio", "ambientes"]) {
      if (origen[c] === "manual") continue;
      const sale = c === "precio" ? pg.precio > 0 : CAMPOS_M2.includes(c) ? (pg.superficies?.[c] != null || (c === "m2_totales" && pg.m2_totales)) : c === "ambientes" ? (pg.ambientes || fi?.campos?.ambientes != null) : !!pg[c];
      if (sale) origen[c] = "pagina";
    }
    if (Object.keys(origen).length) nuevo.origen_campos = origen;
  }
  // El nombre del portal sale del dominio del link, no de lo que diga el modelo
  if (nuevo.link) nuevo.fuente = fuenteDeLink(nuevo.link) || nuevo.fuente;
  if (dePagina.length && !a.solo_pagina) nuevo.datos_pagina = dePagina;
  // Se vuelve a normalizar para recalcular superficie homologada, USD/m² y advertencias con los datos finales
  const [rec] = normalizarAvisos([nuevo], null);
  return rec || nuevo;
}

// ── Tokko (sincronización de propiedades) ────────────────────
// Misma lógica que ModuloTasaciones (tokkoToProp / importar / reparar), pero del lado del servidor:
// la apikey sale de tenants.tokko_key y nunca viaja al navegador.

const TOKKO_BASE = "https://www.tokkobroker.com/api/v1";
const TOKKO_MAX_PAGINAS = 50; // 50 × 20 = 1000 propiedades, igual que Tasaciones
const MAX_SYNC_POR_HORA = Number(process.env.COMPARABLES_TOKKO_POR_HORA || 6);
const QUAL_VARS = ["Ubicación", "Vistas", "Calidad constructiva", "Distribución", "Estacionamiento", "Mantenimiento", "Equipamiento"];
const defQuals = () => Object.fromEntries(QUAL_VARS.map(v => [v, "Equivalente"]));

// Campos técnicos que se completan desde Tokko solo si en la propiedad están vacíos o en "0".
// Nunca se pisa lo que alguien editó a mano. El precio tampoco se toca en propiedades existentes.
const TOKKO_CAMPOS_TECNICOS = [
  "supCubierta", "supSemicubierta", "supDescubierta", "supBalcon", "supTotal",
  "dormitorios", "banos", "estacionamiento", "antiguedad",
  "orientacion", "condicion", "disposicion", "ambientes",
  "_tokkoUrl", "_tokkoRef", "_ciudad",
];

function tokkoToProp(t) {
  const round = v => {
    const n = parseFloat(v);
    return (!isNaN(n) && n > 0) ? String(Math.round(n)) : "";
  };
  const supCubierta = round(t.roofed_surface);
  const supSemicubierta = round(t.semiroofed_surface);
  const supDescubierta = round(t.unroofed_surface);
  const supBalcon = ""; // Tokko no publica m² de balcón
  const supTotal = round(t.surface) || round(t.total_surface) || supCubierta;

  const address = t.address || t.fake_address || "";
  const ciudad = t.location?.name || "";
  const fullLoc = t.location?.full_location || "";
  const barrio = ciudad || (fullLoc ? fullLoc.split("|").pop().trim() : "");

  const tipoMap = {
    "Departamento": "Departamento", "Casa": "Casa", "PH": "PH",
    "Local Comercial": "Local", "Oficina": "Oficina", "Terreno": "Terreno",
    "Duplex": "PH", "Triplex": "PH", "Loft": "Departamento",
    "Casa de campo": "Casa", "Finca": "Casa", "Quinta": "Casa",
    "Chalet": "Casa", "Villa": "Casa",
  };
  const tipo = tipoMap[t.type?.name] || t.type?.name || "Departamento";
  const precio = t.operations?.[0]?.prices?.[0]?.price || 0;
  const antiguedad = (t.age === 0 || t.age === "0") ? "0" : t.age ? String(t.age) : "";
  const dormitorios = t.suite_amount != null ? String(t.suite_amount) : "";
  const ambientes = t.room_amount ? String(t.room_amount) : "";
  const desc = (t.description || t.description_only || "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);

  const missingFields = [];
  if (!supCubierta && !supTotal) missingFields.push("superficies");
  if (!precio) missingFields.push("precio");
  if (!dormitorios) missingFields.push("dormitorios");

  return {
    id: Date.now() + Math.random(),
    direccion: address,
    barrio,
    tipologia: tipo,
    precio: precio ? String(Math.round(precio)) : "",
    supCubierta, supSemicubierta, supDescubierta, supBalcon, supTotal,
    antiguedad, dormitorios, ambientes,
    banos: t.bathroom_amount ? String(t.bathroom_amount) : "",
    estacionamiento: t.parking_lot_amount ? String(t.parking_lot_amount) : "",
    orientacion: t.orientation || "",
    condicion: t.property_condition || "",
    disposicion: t.disposition || "",
    comentarios: desc,
    qualifications: defQuals(),
    agentId: null,
    fecha: new Date().toISOString().slice(0, 10),
    tipo: "base",
    _tokkoId: String(t.id),
    _tokkoUrl: t.public_url || "",
    _tokkoRef: t.reference_code || "",
    _ciudad: ciudad,
    _lat: t.geo_lat ? parseFloat(t.geo_lat) : null,
    _lng: t.geo_long ? parseFloat(t.geo_long) : null,
    _missingFields: missingFields.length ? missingFields : null,
  };
}

// Campos que conviene completar en una propiedad que ya existe (vacío o "0" → valor de Tokko)
function parcheTokko(existente, fresca) {
  const patch = {};
  for (const campo of TOKKO_CAMPOS_TECNICOS) {
    const cur = existente[campo];
    const nxt = fresca[campo];
    const vacio = !cur || cur === "0";
    if (vacio && nxt && nxt !== "0") patch[campo] = nxt;
  }
  if ((!existente._lat || !existente._lng) && fresca._lat && fresca._lng) {
    patch._lat = fresca._lat;
    patch._lng = fresca._lng;
  }
  return patch;
}

// Una página de propiedades de Tokko. Los errores no incluyen la URL (lleva la apikey).
async function tokkoPagina(key, offset) {
  const params = new URLSearchParams({ key, format: "json", lang: "es_ar", limit: "20", offset: String(offset) });
  let res;
  try {
    res = await fetch(`${TOKKO_BASE}/property/?${params}`, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(e?.name === "TimeoutError" ? "Tokko tardó demasiado en responder" : "No se pudo conectar con Tokko");
  }
  if (res.status === 401 || res.status === 403) throw new Error("Tokko rechazó la apikey (revisá la del tenant)");
  if (!res.ok) throw new Error(`Tokko respondió con error ${res.status}`);
  return res.json();
}

// ── Módulo ───────────────────────────────────────────────────

// ── Completar y corregir avisos ya guardados ─────────────────
// Tres vías, todas con su origen marcado (origen_campos): volver a leer la página, leer un texto pegado y cargar a mano.
// Lo cargado a mano no se pisa nunca; si el aviso tenía un valor distinto, queda en "originales" para verlo.
const EDITABLES = {
  precio: "precio", moneda: "moneda",
  m2_cubiertos: "m2", m2_terreno: "m2", m2_totales: "m2", m2_semicubiertos: "m2c", m2_descubiertos: "m2c", m2_balcon: "m2c",
  dormitorios: "ent", banos: "ent", estacionamiento: "ent", ambientes: "ent",
  antiguedad: "ant", condicion: "t40", orientacion: "t30", disposicion: "t30", expensas: "exp",
  direccion: "t120", barrio: "t60", localidad: "t80", tipo: "t60",
};

function convertirCampo(campo, valor) {
  const tipo = EDITABLES[campo];
  if (!tipo) return { error: "ese dato no se puede editar" };
  if (valor === null || valor === "") return { valor: null };
  switch (tipo) {
    case "precio": { const n = aNumero(valor); return n ? { valor: n } : { error: "el precio tiene que ser un número mayor que 0" }; }
    case "moneda": return valor === "USD" || valor === "ARS" ? { valor } : { error: "la moneda es USD o ARS" };
    case "m2": { const n = aNumero(valor); return n && n < 100000 ? { valor: n } : { error: "la superficie tiene que ser un número mayor que 0" }; }
    case "m2c": { const n = aNumeroOCero(valor); return n != null && n < 100000 ? { valor: n } : { error: "la superficie tiene que ser un número (0 si no tiene)" }; }
    case "ent": { const n = aEnteroHasta(valor, 30); return n != null ? { valor: n } : { error: "tiene que ser un número entero entre 0 y 30" }; }
    case "ant": {
      const s = String(valor).trim();
      if (/^\d{1,3}$/.test(s)) return { valor: antiguedadDe(Number(s)) };
      const t = aTexto(s, 40);
      return t ? { valor: t } : { error: "antigüedad inválida" };
    }
    case "exp": { const e = aExpensas(valor); return e ? { valor: e } : { error: "las expensas llevan monto y moneda (ARS o USD)" }; }
    default: { const t = aTexto(valor, Number(tipo.slice(1))); return t ? { valor: t } : { error: "texto inválido" }; }
  }
}

const mismoValor = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Aplica cambios a un aviso y lo vuelve a normalizar (superficie homologada, USD/m², advertencias y faltantes)
function renormalizar(crudo, id) {
  const [rec] = normalizarAvisos([crudo], null);
  if (rec) rec.id = id; // el id no cambia aunque cambie el precio de un aviso sin link
  return rec;
}

// Carga manual. confirmar: true → el tasador da por buenos los datos (habilita incluir un aviso sin verificar); false → lo retira.
function aplicarCambiosManuales(a, cambios, { confirmar } = {}) {
  const errores = [];
  const nuevos = {};
  for (const [campo, v] of Object.entries(cambios || {})) {
    const r = convertirCampo(campo, v);
    if (r.error) errores.push({ campo, motivo: r.error }); else nuevos[campo] = r.valor;
  }
  if (nuevos.precio != null && !("moneda" in nuevos) && !a.moneda) errores.push({ campo: "moneda", motivo: "indicá la moneda del precio (USD o ARS)" });
  if (!Object.keys(nuevos).length && typeof confirmar !== "boolean" && !errores.length) errores.push({ campo: null, motivo: "no hay nada para cambiar" });
  if (errores.length) return { errores };

  const crudo = { ...a };
  const origen = { ...(a.origen_campos || {}) };
  const originales = { ...(a.originales || {}) };
  const cambiados = [];
  for (const [campo, valor] of Object.entries(nuevos)) {
    const antes = a[campo] ?? null;
    if (mismoValor(antes, valor)) continue;
    if (antes != null && originales[campo] === undefined && origen[campo] !== "manual") originales[campo] = antes;
    crudo[campo] = valor;
    origen[campo] = "manual";
    cambiados.push({ campo, antes, despues: valor });
  }
  if (cambiados.length) crudo.editado_a_mano = true;
  if (confirmar === true) crudo.confirmado_a_mano = true;
  if (confirmar === false) delete crudo.confirmado_a_mano;
  crudo.origen_campos = origen;
  crudo.originales = originales;
  return { aviso: renormalizar(crudo, a.id), cambios: cambiados };
}

// Texto pegado (copiado de la publicación): solo se toma lo que el texto dice con su rótulo. Lo cargado a mano no se pisa.
function aplicarFichaTexto(a, texto) {
  const f = leerFichaDeTexto(texto);
  const crudo = { ...a };
  const origen = { ...(a.origen_campos || {}) };
  const originales = { ...(a.originales || {}) };
  const cambiados = [];
  const poner = (campo, valor) => {
    if (valor == null || origen[campo] === "manual") return;
    const antes = a[campo] ?? null;
    if (mismoValor(antes, valor)) return;
    if (antes != null && originales[campo] === undefined) originales[campo] = antes;
    crudo[campo] = valor;
    origen[campo] = "texto_pegado";
    cambiados.push({ campo, antes, despues: valor });
  };
  if (f.precio) { poner("precio", f.precio.valor); poner("moneda", f.precio.moneda); }
  for (const [c, v] of Object.entries(f.superficies)) poner(c, v);
  for (const c of CAMPOS_FICHA) poner(c, f.campos[c]);
  for (const c of ["direccion", "barrio", "localidad"]) poner(c, f.ubicacion[c]);
  if (cambiados.length) {
    const citas = f.evidencia.filter(e => cambiados.some(x => x.campo === e.campo));
    const resto = (a.evidencia || []).filter(e => !citas.some(c => c.campo === e.campo));
    crudo.evidencia = [...resto, ...citas];
  }
  crudo.origen_campos = origen;
  crudo.originales = originales;
  const rec = renormalizar(crudo, a.id);
  return { aviso: rec, cambios: cambiados, encontrados: Object.keys({ ...f.campos, ...f.superficies, ...(f.precio ? { precio: 1 } : {}) }) };
}

// Después de volver a leer la página: lo que la página muestra pisa lo anterior, salvo lo cargado a mano
// (que se conserva y deja el valor de la página en "originales" para compararlo).
function aplicarReLectura(a, v) {
  const leido = aplicarVerificacion(a, v, { releer: true });
  const crudo = { ...leido };
  const origen = { ...(leido.origen_campos || {}) };
  const originales = { ...(a.originales || {}) };
  for (const [campo, o] of Object.entries(a.origen_campos || {})) {
    if (o !== "manual") continue;
    if (leido[campo] != null && !mismoValor(leido[campo], a[campo])) originales[campo] = leido[campo];
    crudo[campo] = a[campo];
    origen[campo] = "manual";
  }
  if (a.editado_a_mano) crudo.editado_a_mano = true;
  if (a.confirmado_a_mano) crudo.confirmado_a_mano = true;
  crudo.origen_campos = origen;
  if (Object.keys(originales).length) crudo.originales = originales;
  return renormalizar(crudo, a.id);
}

// Qué cambió entre dos versiones de un aviso (solo los datos que se muestran)
const CAMPOS_COMPARABLES = ["precio", "moneda", "m2_cubiertos", "m2_semicubiertos", "m2_descubiertos", "m2_balcon", "m2_terreno", "m2_totales",
  "dormitorios", "banos", "estacionamiento", "ambientes", "antiguedad", "condicion", "orientacion", "disposicion", "expensas", "direccion", "barrio", "localidad"];
function diferencias(antes, despues) {
  return CAMPOS_COMPARABLES.filter(c => !mismoValor(antes[c], despues[c])).map(c => ({ campo: c, antes: antes[c] ?? null, despues: despues[c] ?? null }));
}

// ── Avisos para el módulo de Tasaciones ──────────────────────
// Un aviso puede sumarse al cálculo de una tasación si tiene precio en USD, superficie cubierta (en lotes, de terreno)
// y su link se verificó o el tasador confirmó sus datos. Nunca entra solo: lo elige el tasador.
function motivosNoElegible(a) {
  const m = [];
  if (!a.precio) m.push("no tiene precio");
  else if (a.moneda === "ARS") m.push("está publicado en pesos");
  else if (a.moneda !== "USD") m.push("no tiene moneda");
  if (!a.m2_homologados) m.push(/lote|terreno/.test(sinTildes(a.tipo || "")) ? "no tiene superficie de terreno" : "no tiene superficie cubierta");
  if (!(a.verificacion?.estado === "verificado" || a.confirmado_a_mano)) m.push("no se pudo verificar el link: falta que el tasador confirme los datos");
  return m;
}

function tipoATipologia(tipo) {
  const t = sinTildes(tipo || "");
  if (/lote|terreno/.test(t)) return "Terreno";
  if (/local/.test(t)) return "Local";
  if (/oficina/.test(t)) return "Oficina";
  if (/\bph\b|duplex|triplex/.test(t)) return "PH";
  if (/depart|loft|monoamb/.test(t)) return "Departamento";
  if (/casa|quinta|chalet|chacra|campo|villa/.test(t)) return "Casa";
  return aTexto(tipo, 30) || "";
}

// Mismo esquema que tokkoToProp (textos con números), para que Tasaciones lo use como cualquier comparable
function avisoATasacion(a) {
  const num = n => (n != null && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "");
  const lote = /lote|terreno/.test(sinTildes(a.tipo || ""));
  const mAnt = a.antiguedad ? (/estrenar/i.test(a.antiguedad) ? "0" : (String(a.antiguedad).match(/\d+/) || [""])[0]) : "";
  const motivos = motivosNoElegible(a);
  const avisos = [];
  if (a.atipico) avisos.push("su precio por m² está muy fuera de lo habitual en la zona");
  if (a.base_m2 === "homologada_parcial") avisos.push("solo publica la superficie cubierta");
  if (a.editado_a_mano) avisos.push("tiene datos cargados a mano");
  return {
    id: `web_${a.id}`,
    aviso_id: a.id,
    origen: "publicacion_web",
    sin_calificar: true,
    titulo: a.titulo,
    direccion: a.direccion || "",
    barrio: a.barrio || a.localidad || "",
    tipologia: tipoATipologia(a.tipo),
    precio: a.precio && a.moneda === "USD" ? String(Math.round(a.precio)) : "",
    // En lotes la superficie base es la del terreno; Tasaciones solo suma supCubierta y las aperturas
    supCubierta: lote ? num(a.m2_terreno ?? a.m2_totales) : num(a.m2_cubiertos),
    supSemicubierta: lote ? "" : num(a.m2_semicubiertos),
    supDescubierta: lote ? "" : num(a.m2_descubiertos),
    supBalcon: lote ? "" : num(a.m2_balcon),
    supTotal: num(a.m2_totales),
    terreno: num(a.m2_terreno),
    antiguedad: mAnt,
    dormitorios: a.dormitorios != null ? String(a.dormitorios) : "",
    ambientes: a.ambientes != null ? String(a.ambientes) : "",
    banos: a.banos != null ? String(a.banos) : "",
    estacionamiento: a.estacionamiento != null ? String(a.estacionamiento) : "",
    orientacion: a.orientacion || "",
    condicion: a.condicion || "",
    disposicion: a.disposicion || "",
    qualifications: defQuals(),
    link: a.link || null,
    fuente: a.fuente || "",
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    m2_homologados: a.m2_homologados,
    usd_m2: a.usd_m2,
    atipico: !!a.atipico,
    verificado: a.verificacion?.estado === "verificado",
    confirmado_a_mano: !!a.confirmado_a_mano,
    editado_a_mano: !!a.editado_a_mano,
    origen_campos: a.origen_campos || {},
    originales: a.originales || {},
    faltantes: a.faltantes || [],
    faltantes_opc: a.faltantes_opc || [],
    completitud: a.completitud ?? null,
    evidencia: a.evidencia || [],
    elegible: motivos.length === 0,
    motivos_no_elegible: motivos,
    advertencias: avisos,
  };
}

module.exports = function crearModuloComparables({ SB_URL, SB_KEY, sbQuery, anthropic }) {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  // Límites simples en memoria por tenant (control de costo)
  function crearLimite(max, ventanaMs = 60 * 60 * 1000) {
    const uso = new Map(); // tenantId -> [timestamps]
    return (tenantId, cantidad = 1) => {
      const ahora = Date.now();
      const recientes = (uso.get(tenantId) || []).filter(t => ahora - t < ventanaMs);
      if (recientes.length + cantidad > max) {
        uso.set(tenantId, recientes);
        return true;
      }
      for (let i = 0; i < cantidad; i++) recientes.push(ahora);
      uso.set(tenantId, recientes);
      return false;
    };
  }
  const excedeLimite = crearLimite(MAX_POR_HORA_Y_TENANT);
  const excedeLimiteDia = crearLimite(MAX_POR_DIA_Y_TENANT, 24 * 60 * 60 * 1000);

  // Resultados recientes en memoria (se pierden si Render reinicia): repetir la misma búsqueda no gasta tokens
  const cacheBusquedas = new Map();
  const claveCache = (tenantId, p) => JSON.stringify([
    tenantId, sinTildes(p.zona).trim(), sinTildes(p.tipo || ""), p.m2 ? Math.round(p.m2 / 10) * 10 : null, p.ambientes || null, sinTildes(p.notas || "").trim(),
  ]);
  const excedeLimiteGeo = crearLimite(MAX_GEO_POR_HORA);
  const geocoder = crearGeocoder();

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

  async function sbPatch(table, filtro, body) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${filtro}`, {
      method: "PATCH",
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
      throw new Error(`Supabase PATCH ${table} → ${res.status}: ${e}`);
    }
    return res.json();
  }

  async function sbDelete(table, filtro) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${filtro}`, {
      method: "DELETE",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Prefer: "return=representation",
      },
    });
    if (!res.ok) {
      const e = await res.text();
      throw new Error(`Supabase DELETE ${table} → ${res.status}: ${e}`);
    }
    return res.json();
  }

  async function buscarConClaude(params, previos) {
    let messages = [{ role: "user", content: armarPrompt(params, previos) }];
    let modelo = MODELO;
    const pedir = () => anthropic.messages.create({
      model: modelo,
      max_tokens: MAX_TOKENS_SALIDA,
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

    const uso = { input_tokens: 0, output_tokens: 0, busquedas: 0 };
    const sumar = r => {
      uso.input_tokens += r?.usage?.input_tokens || 0;
      uso.output_tokens += r?.usage?.output_tokens || 0;
      uso.busquedas += r?.usage?.server_tool_use?.web_search_requests || 0;
    };

    let resp;
    try {
      resp = await pedir();
    } catch (e) {
      // Si el modelo elegido no admite la herramienta o no existe, se reintenta una vez con el de respaldo
      if ((e?.status === 400 || e?.status === 404) && modelo !== MODELO_RESPALDO) {
        console.warn(`[comparables] ${modelo} falló (${e.status}): reintento con ${MODELO_RESPALDO}`);
        modelo = MODELO_RESPALDO;
        resp = await pedir();
      } else {
        throw e;
      }
    }
    sumar(resp);
    const bloques = [...resp.content];

    // Las búsquedas web del lado del servidor pueden pausar el turno: lo retomamos (cada vuelta reenvía el contexto)
    let vueltas = 0;
    while (resp.stop_reason === "pause_turn" && vueltas < 2) {
      messages = [...messages, { role: "assistant", content: resp.content }];
      resp = await pedir();
      sumar(resp);
      bloques.push(...resp.content);
      vueltas += 1;
    }

    const textosFinal = resp.content.filter(b => b.type === "text").map(b => b.text);
    const textosTodos = bloques.filter(b => b.type === "text").map(b => b.text);
    return {
      texto: textosFinal.join("\n"),
      // El último bloque primero: es donde el modelo pone el JSON. Después los demás, por si lo dejó en otro.
      textos: [...textosFinal].reverse().concat(textosTodos.filter(t => !textosFinal.includes(t)).reverse()),
      stop_reason: resp.stop_reason || null,
      urlsVistas: recolectarUrls(bloques),
      resultadosWeb: recolectarResultados(bloques),
      busquedasWeb: uso.busquedas || bloques.filter(b => b.type === "server_tool_use").length,
      uso: { ...uso, modelo, costo_usd: costoEstimado({ ...uso, busquedas: uso.busquedas || bloques.filter(b => b.type === "server_tool_use").length }, modelo) },
    };
  }

  router.post("/buscar", async (req, res) => {
    const inicio = Date.now();
    try {
      const { tenant_id, zona, tipo, m2, ambientes, notas, ampliar, previos, forzar } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!zona || !String(zona).trim()) return res.status(400).json({ error: "Indicá la zona o el barrio" });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en el backend" });

      const params = {
        zona: String(zona).trim().slice(0, 120),
        tipo: tipo ? String(tipo).slice(0, 60) : null,
        m2: aNumero(m2),
        ambientes: aNumero(ambientes),
        notas: notas ? String(notas).slice(0, 300) : null,
      };

      // Al ampliar, los avisos que ya tenía la pantalla se conservan y se le pide a Claude que no los repita
      const previosN = ampliar ? normalizarAvisos(Array.isArray(previos) ? previos.slice(0, MAX_AVISOS_TOTAL) : [], null) : [];
      if (ampliar && previosN.length >= MAX_AVISOS_TOTAL) {
        return res.status(400).json({ error: `Ya tenés ${MAX_AVISOS_TOTAL} avisos, que es el máximo por búsqueda.` });
      }

      // Misma búsqueda hecha hace poco: se devuelve lo guardado, sin gastar tokens
      const claveC = claveCache(tenant_id, params);
      if (!ampliar && !forzar && CACHE_HORAS > 0) {
        const c = cacheBusquedas.get(claveC);
        if (c && Date.now() - c.ts < CACHE_HORAS * 3600000) {
          return res.json({
            ...c.respuesta,
            desde_cache: true,
            cache_edad_min: Math.round((Date.now() - c.ts) / 60000),
            consumo: { ...(c.respuesta.consumo || {}), costo_usd: 0, desde_cache: true },
          });
        }
      }

      if (excedeLimite(tenant_id)) {
        return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_HORA_Y_TENANT} búsquedas por hora. Probá más tarde.` });
      }
      if (excedeLimiteDia(tenant_id)) {
        return res.status(429).json({ error: `Llegaste al límite de ${MAX_POR_DIA_Y_TENANT} búsquedas por día. Probá mañana.` });
      }

      const { texto, textos, stop_reason, urlsVistas, resultadosWeb, busquedasWeb, uso } = await buscarConClaude(params, previosN);

      // Lectura tolerante de lo que contestó el modelo. Si no se puede leer, la búsqueda sigue con lo que el servidor
      // encuentre por su cuenta en los resultados (listados y páginas de avisos), que no depende del modelo.
      let parsed;
      let respuestaIlegible = false;
      try {
        const lectura = parsearRespuestaModelo(textos);
        parsed = lectura.parsed;
        if (lectura.recuperado) console.warn(`[comparables] buscar: respuesta cortada (stop_reason=${stop_reason}); se rescataron ${parsed.avisos.length} avisos`);
      } catch (e) {
        respuestaIlegible = true;
        // Queda registro de qué devolvió el modelo (antes este error no dejaba ninguna pista en el log)
        console.error(
          `[comparables] buscar: no pude leer la respuesta del modelo (${e.message}). stop_reason=${stop_reason}, ` +
          `${textos.length} bloques de texto, ${texto.length} caracteres, ${uso.output_tokens} tokens de salida, ` +
          `${busquedasWeb} búsquedas web, ${resultadosWeb?.length ?? "?"} resultados web. ` +
          `Inicio: ${JSON.stringify(texto.slice(0, 300))} … Final: ${JSON.stringify(texto.slice(-300))}`
        );
        parsed = { avisos: [], hay_mas: false, notas: "" };
      }

      const idsPrevios = new Set(previosN.map(a => a.id));
      const clavesPrevias = new Set(previosN.map(a => a.link && claveLink(a.link)).filter(Boolean));
      const descartar = (a, estado, motivo) => ({ ...a, verificacion: { estado, motivo } });

      // 1) Un aviso solo vale si trae un link que la búsqueda web devolvió de verdad. Los links que armó el modelo
      //    (por ejemplo, un slug inventado a partir del título) y los avisos sin link se descartan siempre.
      const delModelo = [];
      const descartados = [];
      for (const a of normalizarAvisos(limpiarSalidaModelo(parsed.avisos), urlsVistas).filter(a => !idsPrevios.has(a.id))) {
        if (!a.link) { descartados.push(descartar(a, "sin_link", "el aviso no trae el link de su publicación")); continue; }
        const k = claveLink(a.link);
        if (!urlsVistas.has(k)) { descartados.push(descartar(a, "link_no_visto", "el link no aparece en los resultados de la búsqueda: lo armó el modelo, no es de una publicación real")); continue; }
        if (clavesPrevias.has(k)) continue;
        delModelo.push(a);
      }
      const delModeloCap = quitarDuplicados(delModelo, previosN)
        .slice(0, Math.min(MAX_AVISOS_POR_BUSQUEDA, MAX_AVISOS_TOTAL - previosN.length));

      // 2) Avisos que el servidor encuentra por su cuenta en los resultados (individuales o enlazados desde listados)
      //    y lee de su propia página: el modelo no escribió ningún dato de ellos.
      let delListado = { links: [], listados_leidos: 0, links_en_listados: 0 };
      const paginas = new Map();
      if (VERIFICAR_MODO !== "off") {
        const yaTomadas = new Set([...clavesPrevias, ...delModeloCap.map(a => claveLink(a.link))]);
        delListado = await candidatosDeResultados(resultadosWeb, yaTomadas, paginas, Math.max(0, MAX_CANDIDATOS - delModeloCap.length));
      }
      const soloPagina = normalizarAvisos(delListado.links.map(link => ({ titulo: "", link, solo_pagina: true })), null);
      const candidatos = [...delModeloCap, ...soloPagina];

      // 3) Se abre el link de cada aviso y se contrasta con su página. Los datos de la página mandan.
      let nuevos = candidatos;
      let ilegiblesListado = 0;
      if (VERIFICAR_MODO !== "off" && candidatos.length) {
        const vers = await verificarAvisos(candidatos, paginas);
        const conVerif = candidatos.map((a, k) => aplicarVerificacion(a, vers[k]));
        // Con los datos de la página puede haber duplicados nuevos (mismo precio y dirección): se prefieren los verificados
        const ordenados = [...conVerif.filter(a => a.verificacion.estado === "verificado"), ...conVerif.filter(a => a.verificacion.estado !== "verificado")];
        const sinDup = quitarDuplicados(ordenados, previosN);
        // Quedan como "sin verificar" solo los avisos cuyo link existe pero el portal no dejó leer (bloqueo, error, tiempo).
        // Si la página se leyó y no coincide, es un listado o no existe, el aviso se descarta.
        const QUEDAN = new Set(["inaccesible", "no_legible", "no_verificado"]);
        const conservar = [];
        for (const a of sinDup) {
          const ok = a.verificacion.estado === "verificado";
          if (a.solo_pagina && !ok) { ilegiblesListado++; continue; }
          if (ok || (VERIFICAR_MODO === "marcar" && QUEDAN.has(a.verificacion.estado))) conservar.push(a);
          else descartados.push(a);
        }
        nuevos = conservar;
      }
      nuevos = nuevos.slice(0, Math.min(MAX_AVISOS_POR_BUSQUEDA, MAX_AVISOS_TOTAL - previosN.length));

      const avisos = [...previosN, ...nuevos];
      const porMotivo = {};
      for (const a of descartados) porMotivo[a.verificacion.estado] = (porMotivo[a.verificacion.estado] || 0) + 1;
      const verificados = avisos.filter(a => a.verificacion?.estado === "verificado").length;
      const sinVerificar = avisos.filter(a => a.verificacion && a.verificacion.estado !== "verificado").length;

      if (respuestaIlegible && !nuevos.length) {
        const motivo = stop_reason === "max_tokens" ? "la respuesta se cortó por ser demasiado larga"
          : stop_reason === "pause_turn" ? "la búsqueda quedó a mitad de camino"
          : "el modelo no devolvió los avisos en el formato esperado";
        return res.status(502).json({
          error: "No pude interpretar la respuesta de la búsqueda. Probá de nuevo.",
          detalle: `${motivo} (${stop_reason || "sin motivo de corte"}); no se encontraron avisos por otra vía. Si se repite, probá con una zona más acotada.`,
        });
      }
      const nota = (typeof parsed.notas === "string" ? parsed.notas : "") ||
        (respuestaIlegible ? "El modelo no devolvió datos legibles: se muestran solo los avisos que el servidor leyó por su cuenta de las páginas de los portales." : "");
      const duracion = Date.now() - inicio;
      const sinLink = nuevos.filter(a => !a.link).length;
      console.log(
        `[comparables] buscar${ampliar ? " (ampliar)" : ""}: ${normalizarAvisosCantidad(parsed.avisos)} avisos del modelo, ` +
        `${nuevos.length} quedan (${verificados} verificados, ${sinVerificar} sin verificar), ${descartados.length} descartados ` +
        `${JSON.stringify(porMotivo)}, listados leídos ${delListado.listados_leidos} (${delListado.links_en_listados} links), ` +
        `${soloPagina.length} avisos leídos de su página (${ilegiblesListado} ilegibles), ` +
        `${busquedasWeb} búsquedas web, ${uso.input_tokens} tokens de entrada, ${uso.output_tokens} de salida, ` +
        `costo estimado USD ${uso.costo_usd ?? "?"} (${uso.modelo}), ${duracion} ms`
      );

      const respuesta = {
        parametros: params,
        avisos,
        nuevos: nuevos.length,
        // Si se descartaron avisos, seguir buscando sigue teniendo sentido aunque entren pocos
        hay_mas: avisos.length < MAX_AVISOS_TOTAL && (candidatos.length > 0 || descartados.length > 0) &&
          (parsed.hay_mas === true || candidatos.length >= MAX_AVISOS_POR_BUSQUEDA),
        estadisticas: calcularEstadisticas(avisos),
        notas: ampliar ? `Se sumaron ${nuevos.length} avisos nuevos. ${nota}`.trim() : nota,
        generado: new Date().toISOString(),
        duracion_ms: duracion,
        busquedas_web: busquedasWeb,
        sin_link: avisos.filter(a => !a.link).length,
        verificacion: {
          modo: VERIFICAR_MODO,
          verificados,
          sin_verificar: sinVerificar,
          descartados: descartados.length,
          por_motivo: porMotivo,
          lista: descartados.slice(0, 40).map(a => ({ titulo: a.titulo, fuente: a.fuente, link: a.link, estado: a.verificacion.estado, motivo: a.verificacion.motivo })),
          de_listados: {
            listados_leidos: delListado.listados_leidos,
            links_encontrados: delListado.links_en_listados,
            avisos_leidos: soloPagina.length - ilegiblesListado,
            ilegibles: ilegiblesListado,
          },
        },
        consumo: {
          modelo: uso.modelo,
          tokens_entrada: uso.input_tokens,
          tokens_salida: uso.output_tokens,
          busquedas_web: busquedasWeb,
          costo_usd: uso.costo_usd,
        },
      };
      if (!ampliar && CACHE_HORAS > 0 && avisos.length) {
        if (cacheBusquedas.size >= 100) cacheBusquedas.delete(cacheBusquedas.keys().next().value);
        cacheBusquedas.set(claveC, { ts: Date.now(), respuesta });
      }
      res.json(respuesta);
    } catch (err) {
      console.error("[comparables] buscar:", err);
      res.status(500).json({ error: "Falló la búsqueda de comparables", detalle: err.message });
    }
  });

  // Ubica avisos (o la propiedad propia) en el mapa. Máx. 10 por llamada: la consulta
  // a Nominatim es de 1 por segundo, así que el frontend la llama de a lotes y va dibujando.
  router.post("/geocodificar", async (req, res) => {
    try {
      const { tenant_id, items, centro } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!Array.isArray(items) || !items.length || items.length > 10) {
        return res.status(400).json({ error: "Mandá entre 1 y 10 ubicaciones por llamada" });
      }
      if (excedeLimiteGeo(tenant_id, items.length)) {
        return res.status(429).json({ error: "Llegaste al límite de ubicaciones por hora. Probá más tarde." });
      }

      const c = centro && coordValida(Number(centro.lat), Number(centro.lng))
        ? { lat: Number(centro.lat), lng: Number(centro.lng) }
        : null;

      const resultados = {};
      let fallidos = 0;
      for (const it of items) {
        const id = aTexto(it?.id, 40);
        if (!id) continue;
        try {
          resultados[id] = await geocoder.ubicar(it, c);
        } catch (e) {
          console.error("[comparables] geocodificar:", e.message);
          resultados[id] = null;
          fallidos += 1;
        }
      }
      res.json({ resultados, fallidos });
    } catch (err) {
      console.error("[comparables] geocodificar:", err);
      res.status(500).json({ error: "No se pudo ubicar en el mapa", detalle: err.message });
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
        `tenant_id=eq.${tenant_id}&select=id,data,created_at&order=created_at.desc&limit=100`
      );
      res.json(filas);
    } catch (err) {
      console.error("[comparables] historial:", err);
      res.status(500).json({ error: "No se pudo leer el historial", detalle: err.message });
    }
  });

  // Trae de Tokko las propiedades que faltan y completa datos vacíos de las que ya están.
  // No borra nada, no pisa lo editado a mano y no cambia el precio de las existentes.
  const excedeLimiteSync = crearLimite(MAX_SYNC_POR_HORA);
  router.post("/propiedades/actualizar", async (req, res) => {
    const inicio = Date.now();
    try {
      const { tenant_id } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (excedeLimiteSync(tenant_id)) {
        return res.status(429).json({ error: `Ya actualizaste ${MAX_SYNC_POR_HORA} veces en la última hora. Probá más tarde.` });
      }

      const tenants = await sbQuery("tenants", `id=eq.${tenant_id}&select=tokko_key`);
      const key = String(tenants?.[0]?.tokko_key || "").trim();
      if (!key) return res.status(400).json({ error: "Este tenant no tiene cargada la apikey de Tokko." });

      const filas = await sbQuery("properties", `tenant_id=eq.${tenant_id}&select=id,data&limit=2000`);
      const porTokko = new Map();
      for (const f of filas) {
        const tid = f?.data?._tokkoId;
        if (tid != null && tid !== "") porTokko.set(String(tid), f);
      }

      let nuevas = 0, actualizadas = 0, sinCambios = 0, errores = 0, totalTokko = 0;
      let offset = 0;
      for (let pagina = 0; pagina < TOKKO_MAX_PAGINAS; pagina++) {
        const data = await tokkoPagina(key, offset);
        const objetos = Array.isArray(data?.objects) ? data.objects : [];
        totalTokko += objetos.length;

        for (const t of objetos) {
          if (t?.id == null) continue;
          const clave = String(t.id);
          try {
            const fresca = tokkoToProp(t);
            const existente = porTokko.get(clave);
            if (existente) {
              const patch = existente.yaVisto ? {} : parcheTokko(existente.data || {}, fresca);
              existente.yaVisto = true;
              if (!Object.keys(patch).length) { sinCambios++; continue; }
              const dataNueva = { ...(existente.data || {}), ...patch };
              await sbPatch("properties", `id=eq.${encodeURIComponent(String(existente.id))}&tenant_id=eq.${tenant_id}`, { data: dataNueva });
              existente.data = dataNueva;
              actualizadas++;
            } else {
              const fila = await sbInsert("properties", { tenant_id, data: fresca });
              porTokko.set(clave, { id: fila.id, data: fila.data || fresca, yaVisto: true });
              nuevas++;
            }
          } catch (e) {
            errores++;
            console.error("[comparables] tokko propiedad:", e.message);
          }
        }

        if (!data?.meta?.next || !objetos.length) break;
        offset += 20;
      }

      const duracion = Date.now() - inicio;
      console.log(`[comparables] tokko: ${totalTokko} en Tokko, ${nuevas} nuevas, ${actualizadas} actualizadas, ${sinCambios} sin cambios, ${errores} errores, ${duracion} ms`);
      res.json({ total_tokko: totalTokko, nuevas, actualizadas, sin_cambios: sinCambios, errores, duracion_ms: duracion });
    } catch (err) {
      console.error("[comparables] tokko:", err.message);
      res.status(502).json({ error: err.message || "No se pudo actualizar desde Tokko" });
    }
  });

  // ids de búsquedas guardadas: solo letras, números, guiones y guion bajo (uuid o número)
  const idsValidos = (ids) =>
    Array.isArray(ids) && ids.length > 0 && ids.length <= 200 &&
    ids.every(i => (typeof i === "string" || typeof i === "number") && /^[\w-]{1,64}$/.test(String(i)));
  const listaIds = (ids) => ids.map(i => encodeURIComponent(String(i))).join(",");

  // Pone (o saca, con grupo vacío) un grupo a una o varias búsquedas guardadas.
  // El grupo se guarda dentro de data.grupo, sin cambios en la tabla.
  router.post("/historial/agrupar", async (req, res) => {
    try {
      const { tenant_id, ids, grupo } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!idsValidos(ids)) return res.status(400).json({ error: "Faltan las búsquedas a agrupar" });
      const nombre = aTexto(grupo, 60);
      const filas = await sbQuery(
        "comparables_busquedas",
        `tenant_id=eq.${tenant_id}&id=in.(${listaIds(ids)})&select=id,data`
      );
      let cambiadas = 0;
      for (const f of filas) {
        const data = { ...(f.data || {}) };
        if (nombre) data.grupo = nombre; else delete data.grupo;
        await sbPatch("comparables_busquedas", `id=eq.${encodeURIComponent(String(f.id))}&tenant_id=eq.${tenant_id}`, { data });
        cambiadas += 1;
      }
      res.json({ cambiadas, grupo: nombre });
    } catch (err) {
      console.error("[comparables] agrupar:", err);
      res.status(500).json({ error: "No se pudo agrupar las búsquedas", detalle: err.message });
    }
  });

  // Borra una o varias búsquedas guardadas del tenant
  router.post("/historial/borrar", async (req, res) => {
    try {
      const { tenant_id, ids } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!idsValidos(ids)) return res.status(400).json({ error: "Faltan las búsquedas a borrar" });
      const borradas = await sbDelete("comparables_busquedas", `tenant_id=eq.${tenant_id}&id=in.(${listaIds(ids)})`);
      res.json({ borradas: Array.isArray(borradas) ? borradas.length : 0 });
    } catch (err) {
      console.error("[comparables] borrar:", err);
      res.status(500).json({ error: "No se pudo borrar las búsquedas", detalle: err.message });
    }
  });

  // ── Completar y corregir avisos guardados, y pasarlos a Tasaciones ──
  const MAX_COMPLETAR_POR_HORA = Number(process.env.COMPARABLES_COMPLETAR_POR_HORA || 60);
  const MAX_AVISOS_COMPLETAR = 12;
  const MAX_TEXTO_PEGADO = 20000;
  const excedeLimiteCompletar = crearLimite(MAX_COMPLETAR_POR_HORA);
  const idSimple = v => (typeof v === "string" || typeof v === "number") && /^[\w-]{1,64}$/.test(String(v));

  async function leerBusqueda(tenant_id, busqueda_id) {
    const filas = await sbQuery(
      "comparables_busquedas",
      `tenant_id=eq.${tenant_id}&id=eq.${encodeURIComponent(String(busqueda_id))}&select=id,data,created_at`
    );
    const fila = filas?.[0];
    return fila && Array.isArray(fila.data?.resultado?.avisos) ? fila : null;
  }

  // Guarda los avisos y recalcula las estadísticas (cuentan los que el tasador confirmó o completó)
  async function guardarAvisos(tenant_id, fila, avisos) {
    const estadisticas = calcularEstadisticas(avisos);
    const data = { ...fila.data, resultado: { ...fila.data.resultado, avisos, estadisticas } };
    await sbPatch("comparables_busquedas", `id=eq.${encodeURIComponent(String(fila.id))}&tenant_id=eq.${tenant_id}`, { data });
    return estadisticas;
  }

  // modo "pagina": vuelve a leer el link (de 1 a 12 avisos) · "texto": lee un texto pegado · "manual": carga o corrige a mano
  // No repite la búsqueda ni usa búsquedas web: no gasta tokens.
  router.post("/historial/completar", async (req, res) => {
    try {
      const { tenant_id, busqueda_id, aviso_id, aviso_ids, modo, texto, campos, confirmar } = req.body || {};
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!idSimple(busqueda_id)) return res.status(400).json({ error: "Falta la búsqueda guardada" });
      if (!["pagina", "texto", "manual"].includes(modo)) return res.status(400).json({ error: "El modo tiene que ser pagina, texto o manual" });

      const fila = await leerBusqueda(tenant_id, busqueda_id);
      if (!fila) return res.status(404).json({ error: "No se encontró la búsqueda guardada" });
      const avisos = fila.data.resultado.avisos;

      if (modo === "pagina") {
        const ids = [...new Set((Array.isArray(aviso_ids) ? aviso_ids : [aviso_id]).filter(idSimple).map(String))];
        if (!ids.length || ids.length > MAX_AVISOS_COMPLETAR) {
          return res.status(400).json({ error: `Mandá entre 1 y ${MAX_AVISOS_COMPLETAR} avisos por llamada` });
        }
        const objetivos = ids.map(id => avisos.find(a => a.id === id)).filter(Boolean);
        if (!objetivos.length) return res.status(404).json({ error: "No se encontraron esos avisos en la búsqueda" });
        if (excedeLimiteCompletar(tenant_id, objetivos.length)) {
          return res.status(429).json({ error: "Llegaste al límite de lecturas de páginas por hora. Probá más tarde." });
        }
        const lecturas = await verificarAvisos(objetivos, new Map());
        const informe = [];
        objetivos.forEach((a, k) => {
          const v = lecturas[k];
          if (v.estado !== "verificado") {
            informe.push({ aviso_id: a.id, actualizado: false, estado: v.estado, motivo: v.motivo || "no se pudo abrir el link" });
            return;
          }
          const nuevo = aplicarReLectura(a, v);
          avisos[avisos.findIndex(x => x.id === a.id)] = nuevo;
          informe.push({ aviso_id: a.id, actualizado: true, cambios: diferencias(a, nuevo), faltantes: nuevo.faltantes });
        });
        const estadisticas = await guardarAvisos(tenant_id, fila, avisos);
        return res.json({ modo, informe, avisos: avisos.filter(a => ids.includes(a.id)), estadisticas });
      }

      if (!idSimple(aviso_id)) return res.status(400).json({ error: "Falta el aviso" });
      const pos = avisos.findIndex(a => a.id === String(aviso_id));
      if (pos < 0) return res.status(404).json({ error: "No se encontró ese aviso en la búsqueda" });
      const a = avisos[pos];

      let r;
      if (modo === "texto") {
        const t = typeof texto === "string" ? texto.trim() : "";
        if (t.length < 20) return res.status(400).json({ error: "Pegá el texto de la publicación (con la ficha: superficie, dormitorios, antigüedad, etc.)" });
        if (t.length > MAX_TEXTO_PEGADO) return res.status(400).json({ error: "El texto es demasiado largo" });
        r = aplicarFichaTexto(a, t);
      } else {
        if (campos != null && (typeof campos !== "object" || Array.isArray(campos))) return res.status(400).json({ error: "Los datos a cargar tienen que ser un objeto" });
        r = aplicarCambiosManuales(a, campos || {}, { confirmar: typeof confirmar === "boolean" ? confirmar : undefined });
        if (r.errores) return res.status(400).json({ error: "Hay datos inválidos", errores: r.errores });
      }
      avisos[pos] = r.aviso;
      const estadisticas = await guardarAvisos(tenant_id, fila, avisos);
      res.json({
        modo,
        aviso: r.aviso,
        cambios: r.cambios,
        ...(modo === "texto" ? {
          encontrados: r.encontrados,
          mensaje: r.cambios.length ? null : "No encontré datos con rótulos conocidos en ese texto (por ejemplo \"Dormitorios: 3\", \"Antigüedad: 5\" o \"145 m² cub.\"). Probá copiando también la ficha de la publicación.",
        } : {}),
        estadisticas,
      });
    } catch (err) {
      console.error("[comparables] completar:", err);
      res.status(500).json({ error: "No se pudo completar el aviso", detalle: err.message });
    }
  });

  // Para el módulo de Tasaciones: los avisos de la búsqueda guardada de una propiedad, ya en el esquema de Tasaciones.
  // Sin busqueda_id devuelve la más reciente de esa propiedad; siempre incluye la fecha y la lista de búsquedas disponibles.
  router.get("/para-tasacion", async (req, res) => {
    try {
      const { tenant_id, propiedad_id, busqueda_id } = req.query;
      if (!tenant_id || !UUID_RE.test(tenant_id)) return res.status(400).json({ error: "Falta tenant_id" });
      if (!idSimple(propiedad_id) && !idSimple(busqueda_id)) return res.status(400).json({ error: "Falta propiedad_id o busqueda_id" });
      const filas = await sbQuery(
        "comparables_busquedas",
        `tenant_id=eq.${tenant_id}&select=id,data,created_at&order=created_at.desc&limit=100`
      );
      const dias = f => Math.max(0, Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000));
      const deLaPropiedad = idSimple(propiedad_id)
        ? filas.filter(f => String(f.data?.parametros?.propiedad_id ?? "") === String(propiedad_id))
        : filas;
      const elegida = idSimple(busqueda_id) ? filas.find(f => String(f.id) === String(busqueda_id)) : deLaPropiedad[0];
      const busquedas = deLaPropiedad.map(f => ({
        id: f.id, fecha: f.created_at, hace_dias: dias(f), zona: f.data?.parametros?.zona || null, tipo: f.data?.parametros?.tipo || null,
        avisos: Array.isArray(f.data?.resultado?.avisos) ? f.data.resultado.avisos.length : 0, grupo: f.data?.grupo || null,
      }));
      if (!elegida || !Array.isArray(elegida.data?.resultado?.avisos)) {
        return res.json({ busqueda: null, busquedas, avisos: [], estadisticas: null, resumen: { total: 0, elegibles: 0, no_elegibles: 0 } });
      }
      const guardados = elegida.data.resultado.avisos;
      const conDatos = guardados.map(a => (a.faltantes ? a : { ...a, ...completitudDe(a) })); // búsquedas viejas, sin los campos nuevos
      const estadisticas = calcularEstadisticas(conDatos.map(a => ({ ...a })));
      const avisos = conDatos.map(avisoATasacion);
      const p = elegida.data.parametros || {};
      res.json({
        busqueda: {
          id: elegida.id, fecha: elegida.created_at, hace_dias: dias(elegida), zona: p.zona || null, tipo: p.tipo || null,
          propiedad_id: p.propiedad_id ?? null, m2: p.m2 ?? null, ambientes: p.ambientes ?? null,
        },
        busquedas,
        estadisticas,
        avisos,
        resumen: { total: avisos.length, elegibles: avisos.filter(a => a.elegible).length, no_elegibles: avisos.filter(a => !a.elegible).length },
      });
    } catch (err) {
      console.error("[comparables] para-tasacion:", err);
      res.status(500).json({ error: "No se pudo leer la búsqueda para Tasaciones", detalle: err.message });
    }
  });

  return { router };
};

// Solo para tests locales
module.exports._internals = {
  armarPrompt, parsearJson, parsearRespuestaModelo, objetosJson, aNumero, normalizarAvisos, calcularEstadisticas, percentil,
  limpiarLink, claveLink, hashCorto, recolectarUrls, precisionDe, candidatosGeo, superficieBase,
  distanciaKm, coordValida, limpiarDireccion, crearGeocoder,
  tokkoToProp, parcheTokko, medidas,
  htmlATexto, numerosDe, pareceListado, evaluarDatos, extraerDePagina, superficiesDeTexto, verificarAviso, verificarAvisos, aplicarVerificacion,
  quitarDuplicados, limpiarSalidaModelo, esIpPrivada, hostSeguro, costoEstimado, preciosDeModelo,
  recolectarResultados, pareceUrlDeAviso, fuenteDeLink, esPortadaDisfrazada, buscarNumero, precioUnicoEnTexto,
  confirmarCampos, extraerLinksDeAvisos, candidatosDeResultados, tipoDeTitulo, leerPaginaUnaVez,
  decodificar, leerFicha, leerFichaDeTexto, pareceDireccion, limpiarLocalidad, limpiarTituloPagina, completitudDe, datosDelAviso,
  convertirCampo, aplicarCambiosManuales, aplicarFichaTexto, aplicarReLectura, diferencias, motivosNoElegible, tipoATipologia, avisoATasacion,
};
