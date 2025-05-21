require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { google } = require("googleapis");

// 🧠 Reconstruir el service-account.json desde variable base64
const jsonPath = path.join(__dirname, "service-account.json");

try {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  const buffer = Buffer.from(raw, "base64");
  fs.writeFileSync(jsonPath, buffer); // Guardar como archivo binario directamente
  console.log("✅ service-account.json creado correctamente");
} catch (err) {
  console.error("❌ Error creando service-account.json:", err);
}

// 🎯 Autenticación con Google Drive
const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const drive = google.drive({ version: "v3", auth });

const app = express();

// 🌐 CORS habilitado
app.use(
  cors({
    origin: "https://speaks.eldrincook.com",
    methods: ["GET", "POST"],
    credentials: true,
  })
);

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || "public_html/grabaciones"
);

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`📁 Carpeta de grabaciones creada en: ${RECORDINGS_DIR}`);
}

const upload = multer({ dest: "uploads/" });
app.use(express.static("public_html"));

app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");

  const tempPath = req.file.path;
  const baseFilename = `grabacion-${Date.now()}`;
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`);

  // Mover archivo .webm
  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    }

    // Convertir a mp3
    ffmpeg(webmFinalPath)
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
            fields: "id",
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
            message: "✅ Grabación subida y convertida con éxito.",
            googleDriveUrl: publicUrl,
          });
        } catch (err) {
          console.error("❌ Error al subir a Google Drive:", err);
          res.status(500).send("Error al subir a Google Drive.");
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
