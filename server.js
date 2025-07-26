import express from "express";
import cors from "cors";
import mysql from "mysql2/promise"; // <-- IMPORTANTE: Usando 'mysql2/promise' para async/await
import multer from "multer";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import jwt from "jsonwebtoken"; // <-- NOVA DEPENDÊNCIA: Para autenticação JWT
import bcrypt from "bcryptjs"; // <-- NOVA DEPENDÊNCIA: Para hashing de senhas

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
      error.status = 400; // Define um status para o erro
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
    connection.release(); // Libera conexão
  } catch (err) {
    console.error("❌ Erro ao conectar ao MySQL:", err.message);
    process.exit(1); // Encerra app se não conectar
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
  } else if (err.status && err.message) { // Erros customizados do fileFilter
    return res.status(err.status).json({ erro: err.message });
  }
  next(err); // Passa para o próximo middleware de erro se não for erro do Multer
});

// Middleware de autenticação JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Espera formato: Bearer TOKEN

  if (token == null) {
    return res.status(401).json({ erro: "Token de autenticação não fornecido." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error("Erro na verificação do token:", err);
      // Erro comum: TokenExpiredError
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ erro: "Token expirado. Faça login novamente." });
      }
      return res.status(403).json({ erro: "Token inválido ou acesso negado." });
    }
    req.user = user; // Adiciona as informações do usuário decodificadas ao objeto req
    next();
  });
};

// --- Rotas de Autenticação ---

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ erro: "Usuário e senha são obrigatórios." });
  }

  try {
    const [rows] = await db.query("SELECT * FROM users WHERE username = ?", [username]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ erro: "Usuário não encontrado ou credenciais inválidas." });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ erro: "Senha incorreta ou credenciais inválidas." });
    }

    // Gerar JWT. Payload inclui id e username. Expira em 1 hora.
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ mensagem: "Login bem-sucedido!", token });

  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ erro: "Erro interno do servidor ao tentar fazer login." });
  }
});

// --- Rotas de Culto (Protegidas) ---

// Rota: publicar culto com upload de imagem
app.post("/cultos", authenticateToken, upload.single("imagem"), async (req, res) => {
  const { titulo } = req.body;
  const imagem_path = req.file?.path; // URL da imagem no Cloudinary
  const public_id = req.file?.filename; // Public ID gerado pelo Cloudinary, usado para exclusão

  if (!titulo || !imagem_path) {
    return res.status(400).json({ erro: "Faltando título ou imagem. Certifique-se de que a imagem foi enviada." });
  }

  try {
    const sql = "INSERT INTO cultos (titulo, imagem_path, public_id) VALUES (?, ?, ?)";
    await db.query(sql, [titulo, imagem_path, public_id]);
    res.json({ status: "Culto publicado com sucesso!" });
  } catch (err) {
    console.error("Erro ao inserir culto no DB:", err);
    // Se ocorrer um erro no DB após o upload para Cloudinary, tente remover a imagem
    if (public_id) {
        cloudinary.uploader.destroy(public_id, (error, result) => {
            if (error) console.error("Erro ao deletar imagem do Cloudinary após erro no DB:", error);
            else console.log("Imagem removida do Cloudinary após erro no DB:", result);
        });
    }
    res.status(500).json({ erro: "Erro ao salvar culto." });
  }
});

// Rota: atualizar culto (título e/ou imagem) <-- NOVA ROTA
app.put("/cultos/:id", authenticateToken, upload.single("imagem"), async (req, res) => {
  const { id } = req.params;
  const { titulo } = req.body;
  const new_imagem_path = req.file?.path;
  const new_public_id = req.file?.filename; // Public ID da nova imagem

  if (!titulo && !new_imagem_path) {
    return res.status(400).json({ erro: "Pelo menos um campo (titulo ou imagem) deve ser fornecido para atualização." });
  }

  try {
    let sql;
    let params;
    let old_public_id = null;

    // Se uma nova imagem for enviada, primeiro precisamos do public_id da imagem antiga
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
    } else { // Apenas título
      sql = "UPDATE cultos SET titulo = ? WHERE id = ?";
      params = [titulo, id];
    }

    const [result] = await db.query(sql, params);

    if (result.affectedRows === 0) {
      // Se não encontrou o culto para atualizar, e uma nova imagem foi enviada, delete-a do Cloudinary
      if (new_public_id) {
          cloudinary.uploader.destroy(new_public_id, (error, destroyResult) => {
              if (error) console.error("Erro ao deletar nova imagem do Cloudinary após falha na atualização do DB:", error);
              else console.log("Nova imagem removida do Cloudinary após falha na atualização do DB:", destroyResult);
          });
      }
      return res.status(404).json({ erro: "Culto não encontrado." });
    }

    // Se a atualização foi bem-sucedida e uma nova imagem foi enviada, delete a imagem antiga do Cloudinary
    if (old_public_id && new_imagem_path) {
        cloudinary.uploader.destroy(old_public_id, (error, destroyResult) => {
            if (error) console.error("Erro ao deletar imagem antiga do Cloudinary:", error);
            else console.log("Imagem antiga removida do Cloudinary:", destroyResult);
        });
    }

    res.json({ status: "Culto atualizado com sucesso!" });

  } catch (err) {
    console.error("Erro ao atualizar culto:", err);
    // Em caso de erro, se uma nova imagem foi enviada, tente removê-la do Cloudinary
    if (new_public_id) {
        cloudinary.uploader.destroy(new_public_id, (error, destroyResult) => {
            if (error) console.error("Erro ao deletar nova imagem do Cloudinary após erro no DB:", error);
            else console.log("Nova imagem removida do Cloudinary após erro no DB:", destroyResult);
        });
    }
    res.status(500).json({ erro: "Erro ao atualizar culto." });
  }
});

// Rota: deletar culto (e sua imagem do Cloudinary) <-- ROTA ATUALIZADA
app.delete("/cultos/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Primeiro, obtenha o public_id da imagem para deletar do Cloudinary
    const [cultoRows] = await db.query("SELECT public_id FROM cultos WHERE id = ?", [id]);
    const public_id_to_delete = cultoRows.length > 0 ? cultoRows[0].public_id : null;

    const [result] = await db.query("DELETE FROM cultos WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ erro: "Culto não encontrado." });
    }

    // Se a deleção do DB foi bem-sucedida, delete a imagem do Cloudinary
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


// Rota: pegar último culto (pública) - SEM MUDANÇAS DE FUNCIONALIDADE
app.get("/cultos/ultimo", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM cultos ORDER BY criado_em DESC LIMIT 1");
    res.json(results[0]);
  } catch (err) {
    console.error("Erro ao buscar culto:", err);
    res.status(500).json({ erro: "Erro ao buscar culto." });
  }
});

// --- Rotas de Agenda (Protegidas) ---

// Rota: adicionar evento na agenda <-- ROTA AGORA PROTEGIDA E COM VALIDAÇÃO
app.post("/agenda", authenticateToken, async (req, res) => {
  const { titulo, data_evento, horario, local } = req.body;

  if (!titulo || !data_evento || !horario || !local) {
    return res.status(400).json({ erro: "Preencha todos os campos." });
  }

  // Validação básica de formato de data e hora (pode ser mais robusta com bibliotecas)
  if (isNaN(new Date(data_evento).getTime())) { // Usar getTime() para verificar data inválida
    return res.status(400).json({ erro: "Formato de data inválido. Use YYYY-MM-DD." });
  }
  // Exemplo de validação de horário (regex HH:MM)
  if (!/^(?:2[0-3]|[01]?[0-9]):[0-5][0-9]$/.test(horario)) {
    return res.status(400).json({ erro: "Formato de horário inválido. Use HH:MM." });
  }

  try {
    // A ordem dos parâmetros no SQL e na array DEVE CORRESPONDER
    const sql = "INSERT INTO agenda (titulo, data_evento, horario, local) VALUES (?, ?, ?, ?)";
    await db.query(sql, [titulo, data_evento, horario, local]); // Ordem ajustada para corresponder ao SQL
    res.json({ status: "Evento adicionado com sucesso!" });
  } catch (err) {
    console.error("Erro ao inserir evento:", err);
    res.status(500).json({ erro: "Erro ao cadastrar evento." });
  }
});

// Rota: atualizar evento <-- NOVA ROTA E AGORA PROTEGIDA
app.put("/agenda/:id", authenticateToken, async (req, res) => {
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

  params.push(id); // Adiciona o ID ao final dos parâmetros para a cláusula WHERE

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


// Rota: listar eventos (pública) - SEM MUDANÇAS DE FUNCIONALIDADE
app.get("/agenda", async (req, res) => {
  try {
    // ORDER BY data_evento ASC (eventos mais próximos primeiro), depois por horario
    const [results] = await db.query("SELECT * FROM agenda ORDER BY data_evento ASC, horario ASC");
    res.json(results);
  } catch (err) {
    console.error("Erro ao buscar eventos:", err);
    res.status(500).json({ erro: "Erro ao buscar eventos." });
  }
});

// Rota: deletar evento pelo ID <-- ROTA AGORA PROTEGIDA
app.delete("/agenda/:id", authenticateToken, async (req, res) => {
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