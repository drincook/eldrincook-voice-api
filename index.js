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
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});
const drive = google.drive({ version: "v3", auth });
const app = express();

// 🌐 CORS habilitado

app.use(
  cors({
    origin: "https://speaks.eldrincook.com",
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
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`📁 Carpeta de grabaciones creada en: ${RECORDINGS_DIR}`);
}
const upload = multer({ dest: "uploads/" });
app.use(express.static("public_html"));

// 🔍 Endpoint para listar archivos subidos por la cuenta de servicio

app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("❌ No se subió ningún archivo.");
  const tempPath = req.file.path;
  //const baseFilename = `grabacion-${Date.now()}`;
  let baseFilename = req.body.nombrePersonalizado
    ? req.body.nombrePersonalizado.replace(/\s+/g, "_")
    : `grabacion-${Date.now()}`;

  // Asegura que no tenga extensión repetida
  baseFilename = baseFilename.replace(/\.(webm|mp3)$/i, "");
  const webmFinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(RECORDINGS_DIR, `${baseFilename}.mp3`); // Mover archivo .webm
  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) {
      console.error("❌ Error al mover archivo:", err);
      return res.status(500).send("Error al guardar el archivo.");
    } // Convertir a mp3
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
          const fileId = response.data.id; // Hacer público el archivo
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
            nombre: `${baseFilename}.mp3`,
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
