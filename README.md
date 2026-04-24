# Backend — Álvarez Inmobiliaria · Generador de documentos Word

Reemplaza los tags `{{TAG}}` en plantillas `.docx` con los datos reales de la app.

---

## Instalación (5 minutos)

### Requisitos
- **Node.js 18+** → https://nodejs.org

### Pasos

```bash
# 1. Entrá a la carpeta del backend
cd docx-backend

# 2. Instalá las dependencias
npm install

# 3. Iniciá el servidor
node server.js

# → El servidor queda escuchando en http://localhost:4000
```

Para desarrollo con recarga automática:
```bash
npm run dev   # usa nodemon
```

---

## Endpoints

| Método | URL | Descripción |
|--------|-----|-------------|
| `GET`  | `/api/health` | Estado del servidor |
| `POST` | `/api/generar-docx` | Genera el .docx con los datos reemplazados |

### POST /api/generar-docx

**Content-Type:** `multipart/form-data`

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `plantilla` | `File` (.docx) | ✅ | Plantilla Word con tags `{{TAG}}` |
| `datos` | `string` (JSON) | ✅ | Objeto con los valores a reemplazar |
| `nombre` | `string` | — | Nombre del archivo descargado |

**Respuesta exitosa:** archivo `.docx` para descarga directa.

**Respuesta de error:**
```json
{
  "error": "Mensaje de error",
  "detalle": "Descripción adicional",
  "tags_con_error": [{ "tag": "NOMBRE_TAG", "mensaje": "..." }]
}
```

---

## Cómo crear una plantilla Word

1. Abrí Word y diseñá el documento como quieras
2. Donde quieras que aparezca un dato, escribí el tag entre dobles llaves:

```
El propietario es {{PROPIETARIO}}, DNI {{DNI_PROPIETARIO}}.
La propiedad ubicada en {{PROPIEDAD}} tiene un alquiler de {{MONTO_ACTUAL}}.
```

3. Guardá como `.docx`
4. Subilo desde **Configuración → Plantillas Word** en la app

### ⚠️ Reglas importantes para los tags

- Siempre `{{TAG_EN_MAYUSCULAS}}`
- Sin espacios dentro de las llaves: ✅ `{{PROPIETARIO}}` ❌ `{{ PROPIETARIO }}`
- Sin caracteres especiales en el nombre del tag
- Si Word divide el tag en múltiples runs (puede pasar al tipear), borrá y volvé a escribir el tag completo de una vez

---

## Tags disponibles

### Tasaciones
| Tag | Dato |
|-----|------|
| `{{DIRECCION}}` | Dirección de la propiedad |
| `{{BARRIO}}` | Barrio |
| `{{TIPOLOGIA}}` | Departamento, PH, Casa, etc. |
| `{{SUP_CUBIERTA}}` | Superficie cubierta m² |
| `{{SUP_SEMICUBIERTA}}` | Superficie semicubierta m² |
| `{{SUP_DESCUBIERTA}}` | Superficie descubierta m² |
| `{{SUP_BALCON}}` | Balcón m² |
| `{{DORMITORIOS}}` | Dormitorios |
| `{{BANOS}}` | Baños |
| `{{COCHERAS}}` | Cocheras |
| `{{VALOR_CALCULADO}}` | Valor tasado (USD) |
| `{{VALOR_PCT1}}` | Valor + porcentaje 1 |
| `{{VALOR_PCT2}}` | Valor + porcentaje 2 |
| `{{PCT1}}` | Porcentaje 1 (ej: 10) |
| `{{PCT2}}` | Porcentaje 2 (ej: 20) |
| `{{VALOR_AGENTE}}` | Valor sugerido por el agente |
| `{{FECHA_TASACION}}` | Fecha de la tasación |
| `{{AGENTE_NOMBRE}}` | Nombre del agente |
| `{{AGENTE_TELEFONO}}` | Teléfono del agente |
| `{{INMOBILIARIA}}` | Nombre de la inmobiliaria |
| `{{INMOB_TELEFONO}}` | Teléfono de la inmobiliaria |
| `{{INMOB_EMAIL}}` | Email de la inmobiliaria |
| `{{INMOB_WEB}}` | Web de la inmobiliaria |

### Contratos de alquiler
| Tag | Dato |
|-----|------|
| `{{DOC_ID}}` | ID del contrato (ej: ALV-CTR-2026-0001) |
| `{{ESTADO}}` | Estado (Borrador / Vigente / Vencido) |
| `{{PROPIETARIO}}` | Nombre del propietario |
| `{{DNI_PROPIETARIO}}` | DNI del propietario |
| `{{CUIT_PROPIETARIO}}` | CUIT del propietario |
| `{{DOM_PROPIETARIO}}` | Domicilio del propietario |
| `{{CBU_PROPIETARIO}}` | CBU del propietario |
| `{{INQUILINO}}` | Nombre del inquilino |
| `{{DNI_INQUILINO}}` | DNI del inquilino |
| `{{CUIL_INQUILINO}}` | CUIL del inquilino |
| `{{DOM_INQUILINO}}` | Domicilio del inquilino |
| `{{GARANTE}}` | Nombre del garante |
| `{{DNI_GARANTE}}` | DNI del garante |
| `{{DOM_GARANTE}}` | Domicilio del garante |
| `{{PROPIEDAD}}` | Descripción completa de la propiedad |
| `{{DIR_PROPIEDAD}}` | Solo dirección |
| `{{NOMENCLATURA}}` | Nomenclatura catastral |
| `{{MONTO_INICIAL}}` | Alquiler inicial |
| `{{MONTO_ACTUAL}}` | Alquiler actual |
| `{{DEPOSITO}}` | Depósito |
| `{{HONORARIOS_PCT}}` | % de honorarios |
| `{{HONORARIOS_MTO}}` | Monto de honorarios |
| `{{DIA_VENCIMIENTO}}` | Día de vencimiento (ej: 10) |
| `{{FECHA_INICIO}}` | Inicio del contrato (con nombre del mes) |
| `{{FECHA_FIN}}` | Fin del contrato |
| `{{FECHA_INICIO_SH}}` | Inicio en formato DD/MM/AAAA |
| `{{FECHA_FIN_SH}}` | Fin en formato DD/MM/AAAA |
| `{{INDICE}}` | Índice de actualización (ICL / IPC) |
| `{{PERIODO_ACT}}` | Período (mensual / trimestral / etc.) |
| `{{CLAUSULAS_EXTRA}}` | Cláusulas adicionales |
| `{{AGENTE_NOMBRE}}` | Nombre del agente |
| `{{INMOBILIARIA}}` | Inmobiliaria |
| `{{FECHA_HOY}}` | Fecha de emisión del documento |

### Recibos de pago
| Tag | Dato |
|-----|------|
| `{{DOC_ID}}` | ID del recibo |
| `{{PERIODO}}` | Período (AAAA-MM) |
| `{{MONTO_ALQUILER}}` | Alquiler del período |
| `{{MORA}}` | Mora aplicada |
| `{{TOTAL_COBRADO}}` | Total cobrado |
| `{{FECHA_PAGO}}` | Fecha de pago |
| `{{INQUILINO}}` | Nombre del inquilino |
| `{{DNI_INQUILINO}}` | DNI del inquilino |
| `{{PROPIEDAD}}` | Dirección de la propiedad |
| `{{DOC_CONTRATO}}` | ID del contrato relacionado |

### Liquidaciones
| Tag | Dato |
|-----|------|
| `{{DOC_ID}}` | ID de la liquidación |
| `{{PERIODO}}` | Período (AAAA-MM) |
| `{{FECHA_LIQ}}` | Fecha de generación |
| `{{PROPIETARIO}}` | Nombre del propietario |
| `{{CBU_PROPIETARIO}}` | CBU para la transferencia |
| `{{BANCO_PROP}}` | Banco del propietario |
| `{{EMAIL_PROP}}` | Email del propietario |
| `{{INQUILINO}}` | Nombre del inquilino |
| `{{PROPIEDAD}}` | Dirección de la propiedad |
| `{{TOTAL_COBRADO}}` | Total cobrado en el período |
| `{{HONORARIOS}}` | Honorarios de la inmobiliaria |
| `{{HONORARIOS_PCT}}` | % de honorarios |
| `{{NETO}}` | Neto a transferir al propietario |
| `{{GENERADO_POR}}` | Agente que generó la liquidación |

---

## Despliegue en producción (Railway / Render / VPS)

1. Subí la carpeta `docx-backend` a un repositorio Git
2. En Railway/Render: **New Project → Deploy from GitHub → seleccioná el repo**
3. Configurá la variable de entorno `PORT` (opcional, defecto: 4000)
4. Actualizá `BACKEND_URL` en `docxService.js` con la URL pública del servidor
5. Actualizá el CORS en `server.js` para incluir la URL de tu app en producción

---

## Archivos del backend

```
docx-backend/
├── server.js        → Servidor Express (endpoint principal)
├── mappers.js       → Mapeo de datos de la app → tags del .docx
├── docxService.js   → Helper para llamar al backend desde React
├── package.json     → Dependencias
└── README.md        → Esta documentación
```
