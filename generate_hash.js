// generate_hash.js
import bcrypt from 'bcryptjs'; // <-- Mude 'require' para 'import'

const password = 'casadabencao'; // Troque por sua senha desejada para o admin!
bcrypt.hash(password, 10).then(hash => {
    console.log("Hash gerado:", hash);
});

// Execute: node generate_hash.js