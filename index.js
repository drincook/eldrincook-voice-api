require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { google } = require("googleapis");

// 🔐 Configurar credenciales de Google según entorno
const jsonPath = path.join(__dirname, "service-account.json");

if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
  try {
    const buffer = Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_BASE64,
      "base64"
    );
    fs.writeFileSync(jsonPath, buffer);
    console.log("✅ service-account.json generado desde variable de entorno");
  } catch (err) {
    console.error("❌ Error creando service-account.json desde base64:", err);
  }
} else if (fs.existsSync(jsonPath)) {
  console.log("✅ Archivo 'service-account.json' encontrado localmente.");
} else {
  console.error(
    "❌ No se encontró 'service-account.json' ni GOOGLE_SERVICE_ACCOUNT_BASE64. Deteniendo servidor."
  );
  process.exit(1);
}

// Asegurarse de que la variable de entorno DRIVE_FOLDER_ID esté definida
if (!process.env.DRIVE_FOLDER_ID) {
  console.error(
    "❌ ERROR: La variable de entorno DRIVE_FOLDER_ID no está definida. Deteniendo servidor."
  );
  process.exit(1); // Salir si la variable de entorno crítica no está configurada
} else {
  console.log(`✅ DRIVE_FOLDER_ID configurado: ${process.env.DRIVE_FOLDER_ID}`);
}

// 🎯 Autenticación con Google Drive
const auth = new google.auth.GoogleAuth({
  keyFile: jsonPath,
  scopes: [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly", // Añadido por si se necesita para futuras funciones
  ],
});

const drive = google.drive({ version: "v3", auth });

const app = express();

// Middleware para parsear JSON en el cuerpo de las solicitudes
app.use(express.json());

// 🌐 CORS habilitado
app.use(
  cors({
    origin: "https://speaks.eldrincook.com", // Asegúrate de que esta URL sea la correcta para tu frontend
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  })
);

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || "public_html/grabaciones"
);

// Ruta al modelo RNNoise (se mantiene la ruta, pero el filtro no se aplicará)
const RNNOISE_MODEL_PATH = path.join(__dirname, "rnnoise_models", "sh.rnnn");

// Verificar si el archivo del modelo existe al inicio del servidor (se mantiene la advertencia, pero no es crítico si el filtro está deshabilitado)
if (!fs.existsSync(RNNOISE_MODEL_PATH)) {
  console.warn(
    `⚠️ ADVERTENCIA: El archivo del modelo RNNoise no se encuentra en: ${RNNOISE_MODEL_PATH}`
  );
  console.warn(
    "La reducción de ruido con 'arnndn' no se aplicará (deshabilitada por solicitud)."
  );
} else {
  console.log(
    `✅ Modelo RNNoise encontrado en: ${RNNOISE_MODEL_PATH} (filtro deshabilitado temporalmente)`
  );
}

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`📁 Carpeta de grabaciones creada en: ${RECORDINGS_DIR}`);
}

const upload = multer({ dest: "uploads/" });
// Sirve archivos estáticos desde public_html (para el frontend)
app.use(express.static("public_html"));
// Sirve las grabaciones directamente desde /grabaciones URL
// Esta línea ya no es estrictamente necesaria para la reproducción desde el historial
// si playbackUrl apunta a Google Drive, pero la mantenemos por si acaso se usa para otra cosa.
app.use("/grabaciones", express.static(RECORDINGS_DIR));

// Endpoint para subir y convertir audio
app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");

  const tempPath = req.file.path;
  let baseFilename = req.body.nombrePersonalizado
    ? req.body.nombrePersonalizado.trim().replace(/\s+/g, "_")
    : `grabacion-${Date.now()}`;
  baseFilename = baseFilename.replace(/\.(webm|mp3)$/i, ""); // Asegura que no tenga extensión repetida
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`);

  // Declarar estas variables con 'let' fuera del bloque try
  // para asegurar que siempre existan en el ámbito, incluso si hay un error
  let publicUrl;
  let playbackUrl; // Ahora esta variable tomará el valor de publicUrl
  let fileId;

  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    }

    // Configurar la conversión. Los filtros de reducción de ruido están deshabilitados.
    let ffmpegCommand = ffmpeg(webmFinalPath);

    // --- FILTROS DE REDUCCIÓN DE RUIDO DESHABILITADOS TEMPORALMENTE ---
    // Para habilitarlos en el futuro, descomenta las siguientes líneas:
    // ffmpegCommand.addOption('-ac', '1'); // Forzar a mono
    // ffmpegCommand.addOption('-ar', '16000'); // Forzar a 16kHz (común para modelos RNNoise)
    // if (fs.existsSync(RNNOISE_MODEL_PATH)) {
    //     ffmpegCommand.addOption('-af', `arnndn=m=${RNNOISE_MODEL_PATH}`);
    //     console.log(`✨ Aplicando reducción de ruido con arnndn usando el modelo: ${RNNOISE_MODEL_PATH}`);
    // } else {
    //     console.warn("⚠️ No se aplicó reducción de ruido: Modelo RNNoise no encontrado.");
    // }
    // ------------------------------------------------------------------

    ffmpegCommand
      .toFormat("mp3")
      .on("end", async () => {
        try {
          // Subir el archivo a Google Drive
          const fileMetadata = {
            name: `${baseFilename}.mp3`,
            parents: [process.env.DRIVE_FOLDER_ID], // ID de la carpeta en Drive
          };

          const media = {
            mimeType: "audio/mpeg",
            body: fs.createReadStream(mp3FinalPath),
          };

          const uploadResponse = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: "id", // Solicitar el ID del archivo
          });

          fileId = uploadResponse.data.id; // Asignar a la variable declarada con 'let'

          // Verificar si se obtuvo un fileId válido
          if (!fileId) {
            throw new Error(
              "No se pudo obtener el ID del archivo de Google Drive."
            );
          }

          // Hacer público el archivo
          await drive.permissions.create({
            fileId: fileId,
            requestBody: {
              role: "reader",
              type: "anyone",
            },
          });

          // La URL pública de Google Drive para descarga
          publicUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;

          // --- CAMBIO CLAVE AQUÍ ---
          // La URL para reproducción directa ahora es la misma URL de Google Drive
          playbackUrl = publicUrl;

          res.json({
            message: "✅ Grabación subida, convertida y procesada con éxito.",
            googleDriveUrl: publicUrl, // Para descarga (y ahora también para reproducción)
            playbackUrl: playbackUrl, // Para reproducción directa (apunta a Google Drive)
            nombre: `${baseFilename}.mp3`,
            fileId: fileId,
          });
        } catch (err) {
          console.error("❌ Error al subir a Google Drive:", err);
          // Asegurarse de que solo se envíe una respuesta
          if (!res.headersSent) {
            res.status(500).send("Error al subir a Google Drive.");
          }
        } finally {
          // Limpiar archivos temporales después de la subida y conversión
          fs.unlink(webmFinalPath, (err) => {
            if (err)
              console.error("Error al eliminar archivo webm temporal:", err);
          });
          fs.unlink(mp3FinalPath, (err) => {
            if (err)
              console.error("Error al eliminar archivo mp3 temporal:", err);
          });
        }
      })
      .on("error", (err) => {
        console.error("❌ Error al convertir y/o aplicar filtro a MP3:", err);
        // Asegurarse de que solo se envíe una respuesta
        if (!res.headersSent) {
          res.status(500).send("Error al procesar el archivo.");
        }
      })
      .save(mp3FinalPath);
  });
});

// Endpoint para listar archivos (para ping de estado)
app.get("/files", async (req, res) => {
  try {
    const response = await drive.files.list({
      pageSize: 10,
      fields: "files(id, name, createdTime, webViewLink)",
    });
    console.log("📂 Archivos listados correctamente");
    res.json(response.data.files);
  } catch (err) {
    console.error("❌ Error al listar archivos:", err);
    res.status(500).send("Error al obtener archivos");
  }
});

// Endpoint para Transcripción (Simulado) - Se mantiene en el backend
app.post("/transcribe", async (req, res) => {
  const { fileId } = req.body;

  if (!fileId) {
    return res.status(400).json({
      error: "❌ Se requiere el ID del archivo para la transcripción.",
    });
  }

  console.log(`📝 Solicitud de transcripción para el archivo ID: ${fileId}`);

  try {
    // SIMULACIÓN: Retraso para simular el procesamiento
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // SIMULACIÓN: Respuesta de transcripción
    const simulatedTranscription =
      "Hola, esta es una transcripción de prueba. El audio fue grabado con éxito y procesado con reducción de ruido.";
    res.json({ transcription: simulatedTranscription });
  } catch (error) {
    console.error("❌ Error en la transcripción simulada:", error);
    res.status(500).json({
      error: "Error interno del servidor durante la transcripción simulada.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
