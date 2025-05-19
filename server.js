const express = require("express");
const multer = require("multer");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const FINAL_DIR = path.join(__dirname, "public_html", "grabaciones");
if (!fs.existsSync(FINAL_DIR)) fs.mkdirSync(FINAL_DIR, { recursive: true });

const upload = multer({ dest: "uploads/" });
app.use(express.static("public_html"));

app.post("/upload", upload.single("audio"), (req, res) => {
  const tempPath = req.file.path;
  const baseFilename = `grabacion-${Date.now()}`;
  const webmFinalPath = path.join(FINAL_DIR, `${baseFilename}.webm`);
  const mp3FinalPath = path.join(FINAL_DIR, `${baseFilename}.mp3`);

  fs.rename(tempPath, webmFinalPath, (err) => {
    if (err) return res.status(500).send("Error al mover el archivo");

    ffmpeg(webmFinalPath)
      .toFormat("mp3")
      .on("end", () => {
        res.json({
          message: "Grabación subida y convertida correctamente.",
          urls: {
            webm: `/grabaciones/${baseFilename}.webm`,
            mp3: `/grabaciones/${baseFilename}.mp3`,
          },
        });
      })
      .on("error", (err) => {
        console.error("Error al convertir a MP3:", err);
        res.status(500).send("Error al convertir a MP3");
      })
      .save(mp3FinalPath);
  });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
