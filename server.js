/**
 * ─────────────────────────────────────────────────────────────
 *  BACKEND — Álvarez Inmobiliaria · Reemplazo de tags en .docx
 *  Node.js + Express + docxtemplater + pizzip
 * ─────────────────────────────────────────────────────────────
 *
 *  INSTALACIÓN:
 *    npm install
 *    node server.js
 *
 *  ENDPOINTS:
 *    POST /api/generar-docx   → recibe plantilla + datos, devuelve .docx relleno
 *    GET  /api/health         → estado del servidor
 *
 *  CORS configurado para localhost:3000 (ajustar en producción)
 * ─────────────────────────────────────────────────────────────
 */

const express  = require("express");
const cors     = require("cors");
const multer   = require("multer");
const PizZip   = require("pizzip");
const Docxtemplater = require("docxtemplater");
const path     = require("path");
const fs       = require("fs");

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "https://claude.ai",          // para desarrollo desde Claude artifacts
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" }));

// Multer: recibe el archivo .docx en memoria (no lo guarda en disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || path.extname(file.originalname).toLowerCase() === ".docx") {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten archivos .docx"));
    }
  },
});

// ── Utilidades ────────────────────────────────────────────────

/**
 * Reemplaza tags {{TAG}} en el .docx con los datos del objeto `data`.
 * Devuelve un Buffer con el .docx resultante.
 */
function rellenarPlantilla(templateBuffer, data) {
  const zip = new PizZip(templateBuffer);

  const doc = new Docxtemplater(zip, {
    // paragraphLoop y linebreaks permiten iterar arrays e insertar saltos
    paragraphLoop: true,
    linebreaks:    true,
    // nullGetter: si un tag no existe en data, lo deja vacío en lugar de tirar error
    nullGetter: () => "",
  });

  // Reemplaza los tags con los datos
  doc.render(data);

  // Genera el buffer del archivo resultante
  const buf = doc.getZip().generate({
    type:        "nodebuffer",
    compression: "DEFLATE",
  });

  return buf;
}

// ── ENDPOINT PRINCIPAL ────────────────────────────────────────

/**
 * POST /api/generar-docx
 *
 * Espera un multipart/form-data con:
 *   - plantilla  : archivo .docx con tags {{TAG}}
 *   - datos      : JSON string con los valores a reemplazar
 *   - nombre     : (opcional) nombre sugerido para el archivo descargado
 *
 * Devuelve: el .docx con los tags reemplazados como descarga directa.
 *
 * Ejemplo de objeto `datos` para tasación:
 * {
 *   DIRECCION: "Av. Libertador 1450 Piso 3A",
 *   BARRIO: "Palermo",
 *   TIPOLOGIA: "Departamento",
 *   SUP_CUBIERTA: "75",
 *   VALOR_CALCULADO: "USD 180.000",
 *   FECHA_TASACION: "23 de abril de 2026",
 *   AGENTE_NOMBRE: "Juan Pérez",
 *   ...
 * }
 */
app.post("/api/generar-docx", upload.single("plantilla"), (req, res) => {
  try {
    // Validaciones
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió el archivo .docx (campo: plantilla)" });
    }
    if (!req.body.datos) {
      return res.status(400).json({ error: "Falta el campo 'datos' (JSON string)" });
    }

    let datos;
    try {
      datos = JSON.parse(req.body.datos);
    } catch {
      return res.status(400).json({ error: "El campo 'datos' no es un JSON válido" });
    }

    // Rellena la plantilla
    const docxBuffer = rellenarPlantilla(req.file.buffer, datos);

    // Nombre del archivo descargado
    const nombre = req.body.nombre
      ? req.body.nombre.replace(/[^a-zA-Z0-9_\-\.]/g, "_")
      : `documento_${Date.now()}.docx`;

    // Devuelve el archivo
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.send(docxBuffer);

  } catch (err) {
    console.error("[generar-docx] Error:", err.message);

    // Errores específicos de docxtemplater
    if (err.properties && err.properties.errors) {
      const tagErrors = err.properties.errors.map(e => ({
        tag:     e.properties?.id || "desconocido",
        mensaje: e.message,
      }));
      return res.status(422).json({
        error: "Error en la plantilla .docx",
        detalle: "Revisá que los tags tengan el formato correcto: {{TAG}}",
        tags_con_error: tagErrors,
      });
    }

    res.status(500).json({ error: "Error interno al procesar el documento", detalle: err.message });
  }
});

// ── ENDPOINT HEALTH ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status:  "ok",
    version: "1.0.0",
    ts:      new Date().toISOString(),
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Backend Álvarez Inmobiliaria corriendo en http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/generar-docx`);
  console.log(`   GET  http://localhost:${PORT}/api/health\n`);
});
