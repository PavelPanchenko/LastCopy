/**
 * Парсеры конфигурационных файлов для извлечения DB credentials.
 * Поддерживаемые форматы: wp-config.php, .env, conn.php, env.php
 */

function parseWpConfig(content) {
  const get = (key) => {
    const m = content.match(new RegExp(`define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : null;
  };
  const name = get('DB_NAME');
  if (!name) return null;
  return {
    host: get('DB_HOST') || 'localhost',
    user: get('DB_USER'),
    password: get('DB_PASSWORD'),
    database: name,
    source: 'wp-config.php',
  };
}

function parseDotEnv(content) {
  const get = (keys) => {
    for (const key of keys) {
      const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    }
    return null;
  };
  const database = get(['DB_DATABASE', 'DB_NAME']);
  if (!database) return null;
  return {
    host: get(['DB_HOST']) || 'localhost',
    user: get(['DB_USERNAME', 'DB_USER']),
    password: get(['DB_PASSWORD', 'DB_PASS']),
    database,
    source: '.env',
  };
}

/**
 * conn.php — переменные $db_server, $db_login, $db_pass, $db_base
 * Пример: $db_login = "tet-a-tet";
 */
function parseConnPhp(content) {
  const get = (varName) => {
    const m = content.match(new RegExp(`\\$${varName}\\s*=\\s*['"]([^'"]*)['"]\s*;`));
    return m ? m[1] : null;
  };
  const database = get('db_base') || get('db_name');
  if (!database) return null;
  return {
    host: get('db_server') || get('db_host') || 'localhost',
    user: get('db_login') || get('db_user'),
    password: get('db_pass') || get('db_password'),
    database,
    source: 'conn.php',
  };
}

/**
 * env.php — класс Env со статическими массивами.
 * Берём значения для ключа "server".
 * Пример: private static $db_login = ["local" => "deus", "server" => "tet-a-tet"];
 */
function parseEnvPhp(content) {
  const get = (varName) => {
    const pattern = new RegExp(
      `\\$${varName}\\s*=\\s*\\[([^\\]]+)\\]`,
    );
    const m = content.match(pattern);
    if (!m) return null;
    const serverMatch = m[1].match(/['"]server['"]\s*=>\s*['"]([^'"]*)['"]/);
    return serverMatch ? serverMatch[1] : null;
  };
  const database = get('db_base') || get('db_name');
  if (!database) return null;
  return {
    host: get('db_server') || get('db_host') || 'localhost',
    user: get('db_login') || get('db_user'),
    password: get('db_pass') || get('db_password'),
    database,
    source: 'env.php',
  };
}

const CONFIG_FILES = [
  { filename: 'wp-config.php', parser: parseWpConfig },
  { filename: '.env', parser: parseDotEnv },
  { filename: 'conn.php', parser: parseConnPhp },
  { filename: 'env.php', parser: parseEnvPhp },
];

function parseDbConfig(filename, content) {
  const entry = CONFIG_FILES.find((c) => filename.endsWith(c.filename));
  if (!entry) return null;
  try {
    return entry.parser(content);
  } catch {
    return null;
  }
}

module.exports = { CONFIG_FILES, parseDbConfig };
