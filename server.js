import express from "express";
import cors from "cors";
import mysql from "mysql2";
import multer from "multer";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Servir arquivos estáticos (imagens)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Conexão com MySQL (Railway)
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) {
    console.error("Erro ao conectar ao MySQL:", err);
    return;
  }
  console.log("Conectado ao MySQL do Railway!");
});

// Configuração do multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Rota: inserir culto
app.post("/cultos", upload.single("imagem"), (req, res) => {
  const { titulo } = req.body;
  const imagem_path = req.file ? `/uploads/${req.file.filename}` : null;

  if (!titulo || !imagem_path) {
    return res.status(400).json({ erro: "Faltando título ou imagem" });
  }

  const sql = "INSERT INTO cultos (titulo, imagem_path) VALUES (?, ?)";
  db.query(sql, [titulo, imagem_path], (err) => {
    if (err) {
      console.error("Erro ao inserir no banco:", err);
      return res.status(500).json({ erro: "Erro no banco de dados" });
    }
    res.json({ status: "sucesso" });
  });
});

// Rota: último culto
app.get("/cultos/ultimo", (req, res) => {
  const sql = "SELECT * FROM cultos ORDER BY criado_em DESC LIMIT 1";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Erro ao consultar banco:", err);
      return res.status(500).json({ erro: "Erro no banco de dados" });
    }
    res.json(results[0]);
  });
});

// Rota: adicionar evento
app.post("/agenda", (req, res) => {
  const { titulo, data_evento, horario, local } = req.body;

  if (!titulo || !data_evento || !horario || !local) {
    return res.status(400).json({ erro: "Preencha todos os campos" });
  }

  const sql =
    "INSERT INTO agenda (titulo, data_evento, horario, local) VALUES (?, ?, ?, ?)";
  db.query(sql, [titulo, data_evento, horario, local], (err) => {
    if (err) {
      console.error("Erro ao inserir evento:", err);
      return res.status(500).json({ erro: "Erro ao cadastrar evento" });
    }
    res.json({ status: "sucesso" });
  });
});

// Rota: listar eventos
app.get("/agenda", (req, res) => {
  const sql = "SELECT * FROM agenda ORDER BY data_evento, horario";
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Erro ao buscar eventos:", err);
      return res.status(500).json({ erro: "Erro no banco de dados" });
    }
    res.json(results);
  });
});

// Rota: deletar evento
app.delete("/agenda/:id", (req, res) => {
  const { id } = req.params;

  const sql = "DELETE FROM agenda WHERE id = ?";
  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("Erro ao deletar evento:", err);
      return res.status(500).json({ erro: "Erro ao deletar evento" });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: "Evento não encontrado" });
    }
    res.json({ status: "Evento deletado com sucesso" });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
