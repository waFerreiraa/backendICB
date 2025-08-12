import express from "express";
import cors from "cors";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import dotenv from "dotenv";
import pool from "./database.js"; // importando o pool PostgreSQL

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configurar Cloudinary (igual você já tinha)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "cultos",
    allowed_formats: ["jpg", "png", "jpeg", "webp"],
  },
});

const upload = multer({ storage });

// Testar conexão ao iniciar
pool
  .connect()
  .then((client) => {
    console.log("✅ Conectado ao PostgreSQL Render!");
    client.release();
  })
  .catch((err) => {
    console.error("Erro ao conectar no PostgreSQL:", err);
    process.exit(1);
  });

// Rota publicar culto
app.post("/cultos", upload.single("imagem"), async (req, res) => {
  try {
    const { titulo } = req.body;
    const imagem_path = req.file?.path;

    if (!titulo || !imagem_path) {
      return res.status(400).json({ erro: "Título e imagem são obrigatórios." });
    }

    const sql = "INSERT INTO cultos (titulo, imagem_path) VALUES ($1, $2)";
    await pool.query(sql, [titulo, imagem_path]);

    res.json({ status: "Culto publicado com sucesso!", imagem: imagem_path });
  } catch (err) {
    console.error("Erro ao inserir culto:", err);
    res.status(500).json({ erro: "Erro ao salvar culto." });
  }
});

// Rota pegar último culto
app.get("/cultos/ultimo", async (req, res) => {
  try {
    const sql = "SELECT * FROM cultos ORDER BY criado_em DESC LIMIT 1";
    const result = await pool.query(sql);
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("Erro ao buscar culto:", err);
    res.status(500).json({ erro: "Erro ao buscar culto" });
  }
});

// Rota adicionar evento na agenda
app.post("/agenda", async (req, res) => {
  try {
    const { titulo, data_evento, horario, local } = req.body;

    if (!titulo || !data_evento || !horario || !local) {
      return res.status(400).json({ erro: "Preencha todos os campos" });
    }

    const sql =
      "INSERT INTO agenda (titulo, data_evento, horario, local) VALUES ($1, $2, $3, $4)";
    await pool.query(sql, [titulo, data_evento, horario, local]);

    res.json({ status: "Evento adicionado com sucesso!" });
  } catch (err) {
    console.error("Erro ao inserir evento:", err);
    res.status(500).json({ erro: "Erro ao cadastrar evento" });
  }
});

// Rota listar eventos
app.get("/agenda", async (req, res) => {
  try {
    const sql = "SELECT * FROM agenda ORDER BY data_evento, horario";
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar eventos:", err);
    res.status(500).json({ erro: "Erro ao buscar eventos" });
  }
});

// Rota deletar evento pelo ID
app.delete("/agenda/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = "DELETE FROM agenda WHERE id = $1";
    const result = await pool.query(sql, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: "Evento não encontrado" });
    }
    res.json({ status: "Evento deletado com sucesso" });
  } catch (err) {
    console.error("Erro ao deletar evento:", err);
    res.status(500).json({ erro: "Erro ao deletar evento" });
  }
});

// Middleware de erro (igual o seu)
app.use((err, req, res, next) => {
  console.error("Erro inesperado:", err);
  res
    .status(500)
    .json({ erro: "Erro interno do servidor", detalhes: err.message || err });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
