const bcrypt = require('bcryptjs');
const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Uso: node scripts/hash-password.js "palavra-passe-com-12-ou-mais-caracteres"');
  process.exit(1);
}
bcrypt.hash(password, 12).then(hash => console.log(hash));
