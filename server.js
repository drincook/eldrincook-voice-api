require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const path = require("path");
const { google } = require("googleapis");

const app = express();

// 🌐 Habilitar CORS correctamente
app.use(
  cors({
    origin: "https://speaks.eldrincook.com", // o "*" si querés que sea abierto
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// 🔧 Configurar FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || "public_html/grabaciones"
);

// 📁 Asegura que la carpeta de grabaciones exista
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`📁 Carpeta de grabaciones creada en: ${RECORDINGS_DIR}`);
}

const upload = multer({ dest: "uploads/" });

// 📂 Servimos archivos estáticos desde public_html
app.use(express.static("public_html"));

// 🛠️ Configuración de Google Drive API
const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json", // Asegurate que exista en tu raíz
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const drive = google.drive({ version: "v3", auth });

async function uploadToDrive(filePath, filename) {
  const fileMetadata = {
    name: filename,
  };

  const media = {
    mimeType: "audio/mpeg",
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id, webViewLink",
  });

  return response.data;
}

app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");

  const tempPath = req.file.path;
  const baseFilename = `grabacion-${Date.now()}`;
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`);

  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    }

    ffmpeg(webmFinalPath)
      .toFormat("mp3")
      .on("end", async () => {
        try {
          const publicURL = process.env.PUBLIC_BASE_URL || `/grabaciones`;

          const driveResult = await uploadToDrive(
            
           
          
            mp3FinalPath,
            `${baseFilename}.mp3`
          );
             

          res.json({
            message:
              "✅ Grabación subida, convertida y enviada a Google Drive con éxito.",
            urls: {
              webm: `${publicURL}/${baseFilename}.webm`,
              mp3: `${publicURL}/${baseFilename}.mp3`,
              driveLink: driveResult.webViewLink,
            },
          });
        } catch (error) {
          console.error("❌ Error al subir a Google Drive:", error);
          res.status(500).send("Error al subir el archivo a Google Drive.");
        }
      })
      .on("error", (err) => {
        console.error("❌ Error al convertir a MP3:", err);
        res.status(500).send("Error al convertir el archivo.");
      })
      .save(mp3FinalPath);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
