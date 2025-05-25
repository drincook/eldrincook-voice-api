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

// 🎯 Autenticación con Google Drive
const auth = new google.auth.GoogleAuth({
  keyFile: jsonPath,
  scopes: [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly",
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

// Ruta al modelo RNNoise
// ASEGÚRATE de que este path sea correcto y apunte a tu archivo .rnnn
const RNNOISE_MODEL_PATH = path.join(__dirname, "rnnoise_models", "sh.rnnn");

// Verificar si el archivo del modelo existe
if (!fs.existsSync(RNNOISE_MODEL_PATH)) {
  console.error(
    `❌ ERROR: El archivo del modelo RNNoise no se encuentra en: ${RNNOISE_MODEL_PATH}`
  );
  console.error(
    "Por favor, descarga los modelos de https://github.com/GregorR/rnnoise-models y coloca 'sh.rnnn' (u otro modelo) en la carpeta 'rnnoise_models'."
  );
  // Opcional: podrías decidir si quieres que el servidor se inicie sin el denoiser o si debe fallar.
  // process.exit(1);
} else {
  console.log(`✅ Modelo RNNoise encontrado en: ${RNNOISE_MODEL_PATH}`);
}

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`📁 Carpeta de grabaciones creada en: ${RECORDINGS_DIR}`);
}

const upload = multer({ dest: "uploads/" });
app.use(express.static("public_html"));

// Endpoint para subir y convertir audio
app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");

  const tempPath = req.file.path;
  const baseFilename = req.body.nombrePersonalizado
    ? req.body.nombrePersonalizado.trim().replace(/\s+/g, "_")
    : `grabacion-${Date.now()}`;
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`);

  // Mover archivo .webm
  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    }

    // Configurar la conversión y el filtro de reducción de ruido
    let ffmpegCommand = ffmpeg(webmFinalPath);

    // Construir la cadena de filtros de audio
    let audioFilters = [];

    // Primero, forzar el audio a mono y una tasa de muestreo de 16kHz,
    // que es común para los modelos RNNoise y ayuda a evitar errores de re-inicialización.
    // Usamos el filtro 'asetnsamples' para ajustar la tasa de muestreo y 'channelsplit' para mono.
    // Opciones más directas como .audioChannels() y .audioFrequency() pueden no funcionar
    // bien con filtros complejos si no se aplican en el orden correcto o si el codec de entrada
    // ya está fijado. Usar '-ac' y '-ar' como opciones globales es más robusto.
    ffmpegCommand.addOption("-ac", "1"); // Forzar a mono
    ffmpegCommand.addOption("-ar", "16000"); // Forzar a 16kHz (común para modelos RNNoise)

    // Si el modelo RNNoise existe, añadir el filtro de reducción de ruido a la cadena
    if (fs.existsSync(RNNOISE_MODEL_PATH)) {
      audioFilters.push(`arnndn=m=${RNNOISE_MODEL_PATH}`);
      console.log(
        `✨ Aplicando reducción de ruido con arnndn usando el modelo: ${RNNOISE_MODEL_PATH}`
      );
    } else {
      console.warn(
        "⚠️ No se aplicó reducción de ruido: Modelo RNNoise no encontrado."
      );
    }

    // Aplicar todos los filtros de audio si hay alguno
    if (audioFilters.length > 0) {
      ffmpegCommand.addOption("-af", audioFilters.join(","));
    }

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

          const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: "id", // Solicitar el ID del archivo
          });

          const fileId = response.data.id;

          // Hacer público el archivo
          await drive.permissions.create({
            fileId: fileId,
            requestBody: {
              role: "reader",
              type: "anyone",
            },
          });

          const publicUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;

          res.json({
            message: "✅ Grabación subida, convertida y procesada con éxito.",
            googleDriveUrl: publicUrl,
            nombre: `${baseFilename}.mp3`,
            fileId: fileId,
          });
        } catch (err) {
          console.error("❌ Error al subir a Google Drive:", err);
          res.status(500).send("Error al subir a Google Drive.");
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
        res.status(500).send("Error al procesar el archivo.");
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
