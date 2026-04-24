/**
 * ─────────────────────────────────────────────────────────────
 *  mappers.js — Convierte datos de la app a objetos de tags
 *  para docxtemplater
 * ─────────────────────────────────────────────────────────────
 *
 *  Cada función recibe los datos de la app (tal como se guardan
 *  en Supabase) y devuelve un objeto plano con los tags que el
 *  .docx espera encontrar dentro de {{...}}.
 *
 *  Uso desde el frontend:
 *    const datos = mapearTasacion(tasData, agentData, contactoData);
 *    // POST /api/generar-docx con plantilla + JSON.stringify(datos)
 * ─────────────────────────────────────────────────────────────
 */

// ── Formateadores ─────────────────────────────────────────────

const fmtPesos  = n => n == null || isNaN(n) ? "—" : "$ " + new Intl.NumberFormat("es-AR").format(Math.round(n));
const fmtUSD    = n => n == null || isNaN(n) ? "—" : "USD " + new Intl.NumberFormat("es-AR").format(Math.round(n));
const fmtDate   = d => d ? new Date(d + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" }) : "—";
const fmtDateSh = d => d ? new Date(d + "T00:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const today     = () => new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });

// ── Tags para TASACIÓN ────────────────────────────────────────

/**
 * mapearTasacion(subj, res, agentData, contactoData)
 *
 * @param {Object} subj        - Propiedad tasada (direccion, barrio, etc.)
 * @param {Object} res         - Resultado (vCalc, v110, v120, pct1, pct2, avg, sel)
 * @param {Object} agentData   - { name, telefono }
 * @param {Object} contactoData- { inmobiliaria, telefono, email, web }
 * @param {number} valorManual - Valor sugerido por agente (opcional)
 */
function mapearTasacion(subj, res, agentData, contactoData, valorManual) {
  return {
    DIRECCION:       subj.direccion     || "—",
    BARRIO:          subj.barrio        || "—",
    TIPOLOGIA:       subj.tipologia     || "—",
    SUP_CUBIERTA:    subj.supCubierta   || "—",
    SUP_SEMICUBIERTA:subj.supSemicubierta || "—",
    SUP_DESCUBIERTA: subj.supDescubierta || "—",
    SUP_BALCON:      subj.supBalcon     || "—",
    SUP_TOTAL:       subj.supTotal      || "—",
    DORMITORIOS:     subj.dormitorios   || "—",
    BANOS:           subj.banos         || "—",
    COCHERAS:        subj.estacionamiento || "—",
    ANTIGUEDAD:      subj.antiguedad    || "—",

    VALOR_CALCULADO: fmtUSD(res.vCalc),
    VALOR_PCT1:      fmtUSD(res.v110),
    VALOR_PCT2:      fmtUSD(res.v120),
    PCT1:            String(res.pct1 || 10),
    PCT2:            String(res.pct2 || 20),
    VAL_M2_PROM:     res.avg ? "USD " + Math.round(res.avg).toLocaleString("es-AR") + "/m²" : "—",
    COMPARABLES_N:   String((res.sel || []).length),

    VALOR_AGENTE:    valorManual ? fmtUSD(parseFloat(valorManual)) : "—",
    VALOR_AGENTE_PCT1: valorManual ? fmtUSD(parseFloat(valorManual) * (1 + (res.pct1 || 10) / 100)) : "—",
    VALOR_AGENTE_PCT2: valorManual ? fmtUSD(parseFloat(valorManual) * (1 + (res.pct2 || 20) / 100)) : "—",

    FECHA_TASACION:  today(),
    AGENTE_NOMBRE:   agentData?.name      || "—",
    AGENTE_TELEFONO: agentData?.telefono  || "—",
    INMOBILIARIA:    contactoData?.inmobiliaria || "—",
    INMOB_TELEFONO:  contactoData?.telefono     || "—",
    INMOB_EMAIL:     contactoData?.email        || "—",
    INMOB_WEB:       contactoData?.web          || "—",
  };
}

// ── Tags para CONTRATO DE ALQUILER ────────────────────────────

/**
 * mapearContrato(contrato, propietario, inquilino, propiedad, agentData, contactoData)
 */
function mapearContrato(contrato, propietario, inquilino, propiedad, agentData, contactoData) {
  const pmap = { "1": "mensual", "2": "bimestral", "3": "trimestral", "4": "cuatrimestral", "6": "semestral", "12": "anual" };
  const hon = (parseFloat(contrato.montoInicial) || 0) * (parseFloat(contrato.pctHonorarios) || 9) / 100;

  return {
    DOC_ID:          contrato.docId          || "—",
    ESTADO:          contrato.estado         || "Borrador",
    FECHA_CREACION:  fmtDate(contrato.fechaCreacion),

    PROPIETARIO:     propietario?.nombre     || "—",
    DNI_PROPIETARIO: propietario?.dni        || "—",
    CUIT_PROPIETARIO:propietario?.cuit       || "—",
    DOM_PROPIETARIO: propietario?.domicilio  || "—",
    CBU_PROPIETARIO: propietario?.cbu        || "—",

    INQUILINO:       inquilino?.nombre       || "—",
    DNI_INQUILINO:   inquilino?.dni          || "—",
    CUIL_INQUILINO:  inquilino?.cuil         || "—",
    DOM_INQUILINO:   inquilino?.domicilio    || "—",
    GARANTE:         inquilino?.garanteNombre || "—",
    DNI_GARANTE:     inquilino?.garanteDni   || "—",
    DOM_GARANTE:     inquilino?.garanteDomicilio || "—",

    PROPIEDAD:       propiedad ? `${propiedad.tipo || ""} en ${propiedad.direccion}${propiedad.piso ? ", " + propiedad.piso : ""}, ${propiedad.barrio || ""}, ${propiedad.localidad || ""}` : "—",
    DIR_PROPIEDAD:   propiedad?.direccion    || "—",
    PISO_PROPIEDAD:  propiedad?.piso         || "—",
    NOMENCLATURA:    propiedad?.nomenclatura || "—",

    MONTO_INICIAL:   fmtPesos(parseFloat(contrato.montoInicial)),
    MONTO_ACTUAL:    fmtPesos(parseFloat(contrato.montoActual || contrato.montoInicial)),
    DEPOSITO:        fmtPesos(parseFloat(contrato.deposito) || 0),
    HONORARIOS_PCT:  String(contrato.pctHonorarios || 9),
    HONORARIOS_MTO:  fmtPesos(hon),
    DIA_VENCIMIENTO: String(contrato.diaVencimiento || 10),

    FECHA_INICIO:    fmtDate(contrato.fechaInicio),
    FECHA_FIN:       fmtDate(contrato.fechaFin),
    FECHA_INICIO_SH: fmtDateSh(contrato.fechaInicio),
    FECHA_FIN_SH:    fmtDateSh(contrato.fechaFin),
    FECHA_FIRMA:     fmtDate(contrato.fechaFirma),

    INDICE:          contrato.indice                  || "ICL",
    PERIODO_ACT:     pmap[contrato.periodoActualizacion] || "trimestral",

    MORA_TIPO:       contrato.tipoMora                || "—",
    MORA_PCT:        String(contrato.pctMora || 0),
    MORA_DIAS:       String(contrato.diasGracia || 10),
    MORA_FIJO:       fmtPesos(parseFloat(contrato.montoMora) || 0),

    CLAUSULAS_EXTRA: contrato.clausulasExtra || "",

    AGENTE_NOMBRE:   agentData?.name          || "—",
    INMOBILIARIA:    contactoData?.inmobiliaria || "Álvarez Inmobiliaria",
    INMOB_TELEFONO:  contactoData?.telefono    || "—",
    INMOB_EMAIL:     contactoData?.email       || "—",
    FECHA_HOY:       today(),
  };
}

// ── Tags para RECIBO DE PAGO ──────────────────────────────────

/**
 * mapearRecibo(pago, contrato, inquilino, propiedad, agentData, contactoData)
 */
function mapearRecibo(pago, contrato, inquilino, propiedad, agentData, contactoData) {
  return {
    DOC_ID:          pago.docId              || "—",
    PERIODO:         pago.periodo            || "—",
    MONTO_ALQUILER:  fmtPesos(parseFloat(pago.monto)),
    MORA:            pago.mora > 0 ? fmtPesos(pago.mora) : "Sin mora",
    TOTAL_COBRADO:   fmtPesos(parseFloat(pago.totalCobrado)),
    FECHA_PAGO:      fmtDate(pago.fechaRegistro),
    ESTADO_PAGO:     pago.estado             || "—",
    FORMA_PAGO:      pago.formaPago          || "—",
    REGISTRADO_POR:  pago.registradoPor      || "—",

    INQUILINO:       inquilino?.nombre       || "—",
    DNI_INQUILINO:   inquilino?.dni          || "—",
    PROPIEDAD:       propiedad ? `${propiedad.direccion}${propiedad.piso ? ", " + propiedad.piso : ""}` : "—",

    DOC_CONTRATO:    contrato?.docId         || "—",
    DIA_VENCIMIENTO: String(contrato?.diaVencimiento || 10),

    AGENTE_NOMBRE:   agentData?.name          || "—",
    INMOBILIARIA:    contactoData?.inmobiliaria || "Álvarez Inmobiliaria",
    INMOB_TELEFONO:  contactoData?.telefono    || "—",
    INMOB_EMAIL:     contactoData?.email       || "—",
    FECHA_HOY:       today(),
  };
}

// ── Tags para LIQUIDACIÓN ─────────────────────────────────────

/**
 * mapearLiquidacion(liquidacion, propietario, inquilino, propiedad, contrato, agentData, contactoData)
 */
function mapearLiquidacion(liquidacion, propietario, inquilino, propiedad, contrato, agentData, contactoData) {
  return {
    DOC_ID:          liquidacion.docId       || "—",
    PERIODO:         liquidacion.periodo     || "—",
    FECHA_LIQ:       fmtDate(liquidacion.fecha),

    PROPIETARIO:     propietario?.nombre     || "—",
    CBU_PROPIETARIO: propietario?.cbu        || "—",
    BANCO_PROP:      propietario?.banco      || "—",
    EMAIL_PROP:      propietario?.email      || "—",

    INQUILINO:       inquilino?.nombre       || "—",
    PROPIEDAD:       propiedad ? `${propiedad.direccion}${propiedad.piso ? ", " + propiedad.piso : ""}` : "—",

    TOTAL_COBRADO:   fmtPesos(liquidacion.totalCobrado),
    HONORARIOS:      fmtPesos(liquidacion.honorarios),
    HONORARIOS_PCT:  String(contrato?.pctHonorarios || 9),
    NETO:            fmtPesos(liquidacion.neto),
    NETO_NUM:        String(Math.round(liquidacion.neto || 0)),

    GENERADO_POR:    liquidacion.generadoPor || "—",
    AGENTE_NOMBRE:   agentData?.name          || "—",
    INMOBILIARIA:    contactoData?.inmobiliaria || "Álvarez Inmobiliaria",
    INMOB_TELEFONO:  contactoData?.telefono    || "—",
    INMOB_EMAIL:     contactoData?.email       || "—",
    FECHA_HOY:       today(),
  };
}

module.exports = { mapearTasacion, mapearContrato, mapearRecibo, mapearLiquidacion };
