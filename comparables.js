/**
 * ─────────────────────────────────────────────────────────────
 * MÓDULO — Comparables de mercado
 * Busca avisos en venta de una zona (Claude + búsqueda web), calcula
 * USD/m², ubica los avisos en el mapa y guarda las búsquedas en
 * Supabase (comparables_busquedas).
 *
 *   POST /api/comparables/buscar        → busca (hasta 20 avisos) o amplía (ampliar + previos). No guarda
 *   POST /api/comparables/geocodificar  → ubica avisos en el mapa (Nominatim / OpenStreetMap)
 *   POST /api/comparables/guardar       → guarda una búsqueda
 *   GET  /api/comparables/historial     → últimas 100 búsquedas del tenant (con su grupo, si tienen)
 *   POST /api/comparables/propiedades/actualizar → trae propiedades nuevas y datos faltantes desde Tokko (usa tenants.tokko_key)
 *   POST /api/comparables/historial/agrupar → pone (o saca) un grupo a una o varias búsquedas guardadas
 *   POST /api/comparables/historial/borrar  → borra una o varias búsquedas guardadas
 *
 * Mismo patrón que emp-leads.js / emp-whatsapp.js: factory que recibe las
 * credenciales de Supabase ya armadas en server.js y devuelve un router.
 * No suma dependencias ni variables de entorno nuevas.
 * Opcionales: COMPARABLES_MODEL, COMPARABLES_MAX_SEARCHES (10),
 * COMPARABLES_MAX_POR_HORA (15), COMPARABLES_MAX_AVISOS (20),
 * COMPARABLES_GEO_POR_HORA (400), GEOCODER_UA.
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
//   estricto (por defecto): solo quedan los avisos verificados; el resto se descarta y se informa por qué
//   marcar: quedan todos, pero los no verificados no entran en las estadísticas
//   off: no se verifica
const VERIFICAR_MODO = ["estricto", "marcar", "off"].includes(process.env.COMPARABLES_VERIFICAR_LINKS)
  ? process.env.COMPARABLES_VERIFICAR_LINKS : "estricto";
const VERIF_TIMEOUT_MS = Number(process.env.COMPARABLES_VERIF_TIMEOUT_MS || 9000);
const VERIF_PRESUPUESTO_MS = Number(process.env.COMPARABLES_VERIF_PRESUPUESTO_MS || 40000);
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
- Usá solo avisos que hayas visto realmente en los resultados. Nunca inventes avisos, precios, direcciones ni links. Si un dato no figura, poné null: no lo estimes.
- Priorizá avisos de la zona indicada y de características parecidas (tipo, superficie, ambientes).
- Precio y moneda tal como figuran ("USD" o "ARS").
- "link": la URL exacta del aviso individual, tal como apareció en los resultados. Incluí SOLO avisos de los que tengas esa URL. Nunca la de una página de resultados o de listado, y nunca una URL armada por vos. Si no tenés el link individual, no incluyas el aviso. Cada link se va a abrir para comprobar que muestre los datos que informás.
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

// Lo que el modelo no tiene que decidir (lo agrega el servidor): se descarta de su respuesta
function limpiarSalidaModelo(lista) {
  return (Array.isArray(lista) ? lista : []).map(r =>
    r && typeof r === "object"
      ? { ...r, verificacion: undefined, lat: undefined, lng: undefined, ubic_precision: undefined, ubic_origen: undefined, flags: undefined }
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

    out.push({
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
      fuente: String(raw.fuente || "").slice(0, 60),
      ubicacion_origen: ORIGENES_UBICACION.includes(raw.ubicacion_origen) ? raw.ubicacion_origen : null,
      link,
      motivo_sin_link: link ? null : aTexto(raw.motivo_sin_link, 140),
      // Lo que agrega el servidor al verificar el link (ver verificarAvisos). Se conserva al ampliar y al guardar.
      ...(raw.verificacion && typeof raw.verificacion.estado === "string"
        ? { verificacion: { estado: raw.verificacion.estado.slice(0, 20), motivo: aTexto(raw.verificacion.motivo, 200) } }
        : {}),
      ...(Number.isFinite(raw.lat) && Number.isFinite(raw.lng) && coordValida(raw.lat, raw.lng)
        ? { lat: raw.lat, lng: raw.lng, ubic_precision: ["exacta", "calle"].includes(raw.ubic_precision) ? raw.ubic_precision : "calle", ubic_origen: "pagina" }
        : {}),
      usd_m2: moneda === "USD" && base ? Math.round(precio / base) : null,
      flags,
      atipico: false,
    });
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
const entraEnEstadisticas = a => !a.verificacion || a.verificacion.estado === "verificado";

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

const ENTIDADES = { "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&ordm;": "º", "&sup2;": "²" };
function decodificar(t) {
  return t.replace(/&(?:nbsp|amp|quot|apos|lt|gt|ordm|sup2|#39);/g, m => ENTIDADES[m] || " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return " "; } });
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
  const out = { lat: null, lng: null, direccion: null, localidad: null, precio: null, origen: null, conAltura: false };
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
      if (nodo.address.streetAddress && !out.direccion) out.direccion = aTexto(nodo.address.streetAddress, 120);
      if (nodo.address.addressLocality && !out.localidad) out.localidad = aTexto(nodo.address.addressLocality, 80);
    }
    if (nodo.price != null && out.precio == null) out.precio = aNum(nodo.price);
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
  out.conAltura = !!(out.direccion && /\d/.test(out.direccion));
  return out;
}

const MOTIVOS_ERROR = {
  host_no_permitido: "el link apunta a una dirección que no se puede consultar",
  timeout: "el portal tardó demasiado en responder",
  conexion: "no se pudo conectar con el portal",
  redireccion_invalida: "el link redirige a una dirección inválida",
  demasiadas_redirecciones: "el link redirige demasiadas veces",
  no_html: "el link no lleva a una página web",
};

async function verificarAviso(a) {
  if (!a.link) return { estado: "sin_link", motivo: "no trae el link del aviso" };
  const r = await bajarPagina(a.link);
  if (r.error) return { estado: "inaccesible", motivo: MOTIVOS_ERROR[r.error] || "no se pudo abrir el link" };
  if (r.status === 404 || r.status === 410) return { estado: "inaccesible", motivo: `el link no existe o el aviso se dio de baja (error ${r.status})` };
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

  const ev = evaluarDatos(a, texto, numerosDe(texto));
  const aciertos = [ev.sup, ev.dir, ev.barrio].filter(x => x === true).length;
  const ok = a.precio ? ev.precio === true && aciertos >= 1 : aciertos >= 2;
  const pagina = extraerDePagina(r.html);
  if (!ok) {
    const motivo = a.precio && ev.precio !== true
      ? `el precio publicado (${fmtPrecio(a)}) no se ve en la página del link`
      : "los datos del aviso (superficie, dirección) no se ven en la página del link";
    return { estado: "no_coincide", motivo, pagina };
  }
  return { estado: "verificado", motivo: null, pagina, urlFinal: r.url };
}

// Verifica todos los avisos con hasta 6 consultas en paralelo y un tope de tiempo total
async function verificarAvisos(avisos) {
  const limite = Date.now() + VERIF_PRESUPUESTO_MS;
  const res = new Array(avisos.length);
  let i = 0;
  async function trabajador() {
    for (;;) {
      const k = i++;
      if (k >= avisos.length) return;
      if (Date.now() > limite) { res[k] = { estado: "no_verificado", motivo: "se agotó el tiempo de verificación" }; continue; }
      try { res[k] = await verificarAviso(avisos[k]); }
      catch { res[k] = { estado: "inaccesible", motivo: "no se pudo abrir el link" }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VERIF_CONCURRENCIA, avisos.length) }, trabajador));
  return res;
}

// Guarda en el aviso el resultado de la verificación y, si la página trae coordenadas, las usa para el mapa
function aplicarVerificacion(a, v) {
  a.verificacion = { estado: v.estado, motivo: v.motivo || null };
  const pg = v.pagina;
  if (v.estado === "verificado" && pg) {
    if (pg.lat != null && pg.lng != null) {
      a.lat = pg.lat; a.lng = pg.lng;
      a.ubic_precision = pg.conAltura ? "exacta" : "calle";
      a.ubic_origen = "pagina";
    }
    if (!a.direccion && pg.direccion) a.direccion = pg.direccion;
    if (!a.localidad && pg.localidad) a.localidad = pg.localidad;
  }
  if (v.estado !== "verificado" && !a.flags.includes("no_verificado")) a.flags.push("no_verificado");
  return a;
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

    return {
      texto: resp.content.filter(b => b.type === "text").map(b => b.text).join("\n"),
      urlsVistas: recolectarUrls(bloques),
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

      const { texto, urlsVistas, busquedasWeb, uso } = await buscarConClaude(params, previosN);

      let parsed;
      try {
        parsed = parsearJson(texto);
      } catch {
        return res.status(502).json({ error: "No pude interpretar la respuesta de la búsqueda. Probá de nuevo." });
      }

      const idsPrevios = new Set(previosN.map(a => a.id));
      const candidatos = quitarDuplicados(
        normalizarAvisos(limpiarSalidaModelo(parsed.avisos), urlsVistas).filter(a => !idsPrevios.has(a.id)),
        previosN
      ).slice(0, Math.min(MAX_AVISOS_POR_BUSQUEDA, MAX_AVISOS_TOTAL - previosN.length));

      // Se abre el link de cada aviso nuevo. En modo estricto solo quedan los verificados.
      let nuevos = candidatos;
      let descartados = [];
      if (VERIFICAR_MODO !== "off" && candidatos.length) {
        const vers = await verificarAvisos(candidatos);
        candidatos.forEach((a, k) => aplicarVerificacion(a, vers[k]));
        if (VERIFICAR_MODO === "estricto") {
          descartados = candidatos.filter(a => a.verificacion.estado !== "verificado");
          nuevos = candidatos.filter(a => a.verificacion.estado === "verificado");
        }
      }
      const avisos = [...previosN, ...nuevos];
      const porMotivo = {};
      for (const a of descartados) porMotivo[a.verificacion.estado] = (porMotivo[a.verificacion.estado] || 0) + 1;
      const verificados = avisos.filter(a => a.verificacion?.estado === "verificado").length;

      const nota = typeof parsed.notas === "string" ? parsed.notas : "";
      const duracion = Date.now() - inicio;
      const sinLink = nuevos.filter(a => !a.link).length;
      console.log(
        `[comparables] buscar${ampliar ? " (ampliar)" : ""}: ${candidatos.length} avisos, ${nuevos.length} verificados, ${descartados.length} descartados ` +
        `${JSON.stringify(porMotivo)}, ${busquedasWeb} búsquedas web, ${uso.input_tokens} tokens de entrada, ${uso.output_tokens} de salida, ` +
        `costo estimado USD ${uso.costo_usd ?? "?"} (${uso.modelo}), ${duracion} ms`
      );

      const respuesta = {
        parametros: params,
        avisos,
        nuevos: nuevos.length,
        // Si se descartaron avisos, seguir buscando sigue teniendo sentido aunque entren pocos
        hay_mas: avisos.length < MAX_AVISOS_TOTAL && candidatos.length > 0 &&
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
          descartados: descartados.length,
          por_motivo: porMotivo,
          lista: descartados.slice(0, 40).map(a => ({ titulo: a.titulo, fuente: a.fuente, link: a.link, estado: a.verificacion.estado, motivo: a.verificacion.motivo })),
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

  return { router };
};

// Solo para tests locales
module.exports._internals = {
  armarPrompt, parsearJson, aNumero, normalizarAvisos, calcularEstadisticas, percentil,
  limpiarLink, claveLink, hashCorto, recolectarUrls, precisionDe, candidatosGeo, superficieBase,
  distanciaKm, coordValida, limpiarDireccion, crearGeocoder,
  tokkoToProp, parcheTokko, medidas,
  htmlATexto, numerosDe, pareceListado, evaluarDatos, extraerDePagina, verificarAviso, verificarAvisos, aplicarVerificacion,
  quitarDuplicados, limpiarSalidaModelo, esIpPrivada, hostSeguro, costoEstimado, preciosDeModelo,
};
