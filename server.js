import express from "express";
import cors from "cors";
import mysql from "mysql2/promise"; // Continua usando 'mysql2/promise' para async/await
import multer from "multer";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
// import jwt from "jsonwebtoken"; // REMOVIDO
// import bcrypt from "bcryptjs"; // REMOVIDO

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configurar Multer com Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    return {
      folder: "cultos", // Pasta no Cloudinary
      public_id: `culto_${Date.now()}_${file.originalname.split('.')[0]}`.replace(/[^a-zA-Z0-9-_]/g, ''), // Nome do arquivo único, limpa caracteres especiais
      allowed_formats: ["jpg", "png", "jpeg", "webp"],
    };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limite de tamanho de arquivo
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.mimetype)) {
      const error = new Error("Formato de arquivo não permitido. Apenas JPG, PNG, WEBP.");
      error.status = 400;
      return cb(error, false);
    }
    cb(null, true);
  },
});

// Criar pool de conexões MySQL (usando promessas)
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Testar conexão no start do servidor (usando async/await)
(async () => {
  try {
    const connection = await db.getConnection();
    console.log("✅ Conectado ao MySQL do Railway!");
    connection.release();
  } catch (err) {
    console.error("❌ Erro ao conectar ao MySQL:", err.message);
    process.exit(1);
  }
})();

// --- Middlewares ---

// Middleware para tratamento de erros do Multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ erro: "Arquivo muito grande. Máximo 5MB." });
    }
    return res.status(400).json({ erro: err.message });
  } else if (err.status && err.message) {
    return res.status(err.status).json({ erro: err.message });
  }
  next(err);
});

// REMOVIDO: Middleware de autenticação JWT
// REMOVIDO: Rotas de Autenticação (/login)

// --- Rotas de Culto (AGORA PÚBLICAS) ---

// Rota: publicar culto com upload de imagem
app.post("/cultos", upload.single("imagem"), async (req, res) => {
  const { titulo } = req.body;
  const imagem_path = req.file?.path;
  const public_id = req.file?.filename;

  if (!titulo || !imagem_path) {
    return res.status(400).json({ erro: "Faltando título ou imagem. Certifique-se de que a imagem foi enviada." });
  }

  try {
    const sql = "INSERT INTO cultos (titulo, imagem_path, public_id) VALUES (?, ?, ?)";
    await db.query(sql, [titulo, imagem_path, public_id]);
    res.json({ status: "Culto publicado com sucesso!" });
  } catch (err) {
    console.error("Erro ao inserir culto no DB:", err);
    if (public_id) {
        cloudinary.uploader.destroy(public_id, (error, result) => {
            if (error) console.error("Erro ao deletar imagem do Cloudinary após erro no DB:", error);
            else console.log("Imagem removida do Cloudinary após erro no DB:", result);
        });
    }
    res.status(500).json({ erro: "Erro ao salvar culto." });
  }
});

// Rota: atualizar culto (título e/ou imagem)
app.put("/cultos/:id", upload.single("imagem"), async (req, res) => {
  const { id } = req.params;
  const { titulo } = req.body;
  const new_imagem_path = req.file?.path;
  const new_public_id = req.file?.filename;

  if (!titulo && !new_imagem_path) {
    return res.status(400).json({ erro: "Pelo menos um campo (titulo ou imagem) deve ser fornecido para atualização." });
  }

  try {
    let sql;
    let params;
    let old_public_id = null;

    if (new_imagem_path) {
        const [cultoRows] = await db.query("SELECT public_id FROM cultos WHERE id = ?", [id]);
        if (cultoRows.length > 0) {
            old_public_id = cultoRows[0].public_id;
        }
    }

    if (new_imagem_path && titulo) {
      sql = "UPDATE cultos SET titulo = ?, imagem_path = ?, public_id = ? WHERE id = ?";
      params = [titulo, new_imagem_path, new_public_id, id];
    } else if (new_imagem_path) {
      sql = "UPDATE cultos SET imagem_path = ?, public_id = ? WHERE id = ?";
      params = [new_imagem_path, new_public_id, id];
    } else {
      sql = "UPDATE cultos SET titulo = ? WHERE id = ?";
      params = [titulo, id];
    }

    const [result] = await db.query(sql, params);

    if (result.affectedRows === 0) {
      if (new_public_id) {
          cloudinary.uploader.destroy(new_public_id, (error, destroyResult) => {
              if (error) console.error("Erro ao deletar nova imagem do Cloudinary após falha na atualização do DB:", error);
              else console.log("Nova imagem removida do Cloudinary após falha na atualização do DB:", destroyResult);
          });
      }
      return res.status(404).json({ erro: "Culto não encontrado." });
    }

    if (old_public_id && new_imagem_path) {
        cloudinary.uploader.destroy(old_public_id, (error, destroyResult) => {
            if (error) console.error("Erro ao deletar imagem antiga do Cloudinary:", error);
            else console.log("Imagem antiga removida do Cloudinary:", destroyResult);
        });
    }

    res.json({ status: "Culto atualizado com sucesso!" });

  } catch (err) {
    console.error("Erro ao atualizar culto:", err);
    if (new_public_id) {
        cloudinary.uploader.destroy(new_public_id, (error, destroyResult) => {
            if (error) console.error("Erro ao deletar nova imagem do Cloudinary após erro no DB:", error);
            else console.log("Nova imagem removida do Cloudinary após erro no DB:", destroyResult);
        });
    }
    res.status(500).json({ erro: "Erro ao atualizar culto." });
  }
});

// Rota: deletar culto (e sua imagem do Cloudinary)
app.delete("/cultos/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [cultoRows] = await db.query("SELECT public_id FROM cultos WHERE id = ?", [id]);
    const public_id_to_delete = cultoRows.length > 0 ? cultoRows[0].public_id : null;

    const [result] = await db.query("DELETE FROM cultos WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: "Culto não encontrado." });
    }

    if (public_id_to_delete) {
      cloudinary.uploader.destroy(public_id_to_delete, (error, destroyResult) => {
        if (error) console.error("Erro ao deletar imagem do Cloudinary:", error);
        else console.log("Imagem removida do Cloudinary:", destroyResult);
      });
    }

    res.json({ status: "Culto deletado com sucesso!" });
  } catch (err) {
    console.error("Erro ao deletar culto:", err);
    res.status(500).json({ erro: "Erro ao deletar culto." });
  }
});

// Rota: pegar último culto (pública)
app.get("/cultos/ultimo", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM cultos ORDER BY criado_em DESC LIMIT 1");
    res.json(results[0]);
  } catch (err) {
    console.error("Erro ao buscar culto:", err);
    res.status(500).json({ erro: "Erro ao buscar culto." });
  }
});

// --- Rotas de Agenda (AGORA PÚBLICAS) ---

// Rota: adicionar evento na agenda
app.post("/agenda", async (req, res) => {
  const { titulo, data_evento, horario, local } = req.body;

  if (!titulo || !data_evento || !horario || !local) {
    return res.status(400).json({ erro: "Preencha todos os campos." });
  }

  if (isNaN(new Date(data_evento).getTime())) {
    return res.status(400).json({ erro: "Formato de data inválido. Use YYYY-MM-DD." });
  }
  if (!/^(?:2[0-3]|[01]?[0-9]):[0-5][0-9]$/.test(horario)) {
    return res.status(400).json({ erro: "Formato de horário inválido. Use HH:MM." });
  }

  try {
    const sql = "INSERT INTO agenda (titulo, data_evento, horario, local) VALUES (?, ?, ?, ?)";
    await db.query(sql, [titulo, data_evento, horario, local]);
    res.json({ status: "Evento adicionado com sucesso!" });
  } catch (err) {
    console.error("Erro ao inserir evento:", err);
    res.status(500).json({ erro: "Erro ao cadastrar evento." });
  }
});

// Rota: atualizar evento
app.put("/agenda/:id", async (req, res) => {
  const { id } = req.params;
  const { titulo, data_evento, horario, local } = req.body;

  if (!titulo && !data_evento && !horario && !local) {
    return res.status(400).json({ erro: "Pelo menos um campo deve ser fornecido para atualização." });
  }

  const updates = [];
  const params = [];

  if (titulo) {
    updates.push("titulo = ?");
    params.push(titulo);
  }
  if (data_evento) {
    if (isNaN(new Date(data_evento).getTime())) {
      return res.status(400).json({ erro: "Formato de data inválido. Use YYYY-MM-DD." });
    }
    updates.push("data_evento = ?");
    params.push(data_evento);
  }
  if (horario) {
    if (!/^(?:2[0-3]|[01]?[0-9]):[0-5][0-9]$/.test(horario)) {
      return res.status(400).json({ erro: "Formato de horário inválido. Use HH:MM." });
    }
    updates.push("horario = ?");
    params.push(horario);
  }
  if (local) {
    updates.push("local = ?");
    params.push(local);
  }

  if (updates.length === 0) {
    return res.status(400).json({ erro: "Nenhum campo válido para atualização fornecido." });
  }

  params.push(id);

  const sql = `UPDATE agenda SET ${updates.join(", ")} WHERE id = ?`;

  try {
    const [result] = await db.query(sql, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: "Evento não encontrado." });
    }
    res.json({ status: "Evento atualizado com sucesso!" });
  } catch (err) {
    console.error("Erro ao atualizar evento:", err);
    res.status(500).json({ erro: "Erro ao atualizar evento." });
  }
});

// Rota: listar eventos (pública)
app.get("/agenda", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM agenda ORDER BY data_evento ASC, horario ASC");
    res.json(results);
  } catch (err) {
    console.error("Erro ao buscar eventos:", err);
    res.status(500).json({ erro: "Erro ao buscar eventos." });
  }
});

// Rota: deletar evento pelo ID
app.delete("/agenda/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query("DELETE FROM agenda WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: "Evento não encontrado." });
    }
    res.json({ status: "Evento deletado com sucesso!" });
  } catch (err) {
    console.error("Erro ao deletar evento:", err);
    res.status(500).json({ erro: "Erro ao deletar evento." });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});