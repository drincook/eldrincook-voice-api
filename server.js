require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const path = require("path");

const app = express(); // 🟢 Mueve esto antes de usar `app`

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

app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");

  const tempPath = req.file.path;
  const baseFilename = `grabacion-${Date.now()}`;
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`);

  // 📥 Mover el archivo .webm
  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    }

    // 🎧 Convertir a .mp3 con ffmpeg
    ffmpeg(webmFinalPath)
      .toFormat("mp3")
      .on("end", () => {
        const publicURL = process.env.PUBLIC_BASE_URL || `/grabaciones`;

        res.json({
          message: "✅ Grabación subida y convertida con éxito.",
          urls: {
            webm: `${publicURL}/${baseFilename}.webm`,
            mp3: `${publicURL}/${baseFilename}.mp3`,
          },
        });
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
