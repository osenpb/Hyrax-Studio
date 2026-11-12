// Los mensajes de error del backend (Rust) están escritos en español. En inglés se traducen aquí, con reglas
// que reconocen la plantilla del mensaje y conservan los datos variables (nombres, números, errores del servidor).
// `{}` marca un dato variable en la plantilla en español; `{1}`, `{2}`… lo recuperan en la traducción.
//
// Hay una prueba (backend.test.ts) que lee los fuentes de Rust y falla si aparece un mensaje sin traducción.

import { getLang } from "./index";

const RULES: [string, string][] = [
  // --- sesiones y conexiones ---
  ["La conexión se cerró. Vuelve a conectarte.", "The connection was closed. Connect again."],
  ["La conexión no está abierta.", "The connection is not open."],
  ["La conexión de MongoDB no está abierta. Vuelve a conectarte.", "The MongoDB connection is not open. Connect again."],
  ["La conexión no es de MongoDB.", "The connection is not a MongoDB one."],
  ["Conexión no encontrada", "Connection not found"],
  ["profiles.json inválido: {}", "Invalid profiles.json: {1}"],
  [
    "No se pudo verificar que la contraseña quedó guardada en el almacén del sistema; el archivo de conexiones no se modificó.",
    "Could not verify that the password was saved in the system credential store; the connections file was not modified.",
  ],
  ["Para borrar todo hay que escribir BORRAR (o ERASE).", "To erase everything you must type ERASE (or BORRAR)."],
  [
    "No se borró todo; se conservaron las conexiones para poder reintentar. {}",
    "Not everything was erased; the connections were kept so you can retry. {1}",
  ],
  ["No se pudo borrar la copia antigua de PgDesk ({}): {}", "Could not delete the old PgDesk copy ({1}): {2}"],
  [
    "El explorador de MongoDB llega en la fase M1. Por ahora puedes crear la conexión y probarla.",
    "The MongoDB explorer arrives in phase M1. For now you can create the connection and test it.",
  ],
  [
    "Para eliminar una base de datos hay que habilitar antes la escritura en este servidor (botón de modo de cualquiera de sus bases).",
    "To drop a database you must first enable writing on this server (the mode button of any of its databases).",
  ],
  // --- almacén de credenciales ---
  ["No se pudo acceder al almacén de credenciales del sistema: {}", "Could not access the system credential store: {1}"],
  ["No se pudo guardar la contraseña en el almacén del sistema: {}", "Could not save the password in the system store: {1}"],
  ["No se pudo leer la contraseña del almacén del sistema: {}", "Could not read the password from the system store: {1}"],
  ["No se pudo borrar una contraseña antigua del almacén del sistema: {}", "Could not delete an old password from the system store: {1}"],
  ["No se pudo borrar la contraseña del almacén del sistema: {}", "Could not delete the password from the system store: {1}"],
  // --- consultas, sesión y modo ---
  ["Tiempo de espera agotado: la consulta superó el límite configurado.", "Timeout: the query exceeded the configured limit."],
  ["Consulta cancelada.", "Query cancelled."],
  [
    "\nHyrax: esta sesión está en modo solo lectura. Desactívalo desde la barra del editor SQL para escribir.",
    "\nHyrax: this session is in read-only mode. Turn it off from the SQL editor bar to write.",
  ],
  ["El filtro contiene un carácter no válido.", "The filter contains an invalid character."],
  ["No se pudo leer el certificado de la CA ({}): {}", "Could not read the CA certificate ({1}): {2}"],
  ["No se pudo leer el certificado de la CA ({}).", "Could not read the CA certificate ({1})."],
  ["El certificado de la CA no es un PEM válido: {}", "The CA certificate is not a valid PEM: {1}"],
  [
    "Esta es una conexión de producción: para habilitar la escritura hay que confirmar escribiendo el nombre de la base de datos ({}).",
    "This is a production connection: to enable writing you must confirm by typing the database name ({1}).",
  ],
  [
    "La sesión está en modo solo lectura: no se permite cambiar el modo de transacción desde SQL. Usa el botón de modo del editor.",
    "The session is read-only: changing the transaction mode from SQL is not allowed. Use the editor's mode button.",
  ],
  [
    "El ensayo con ROLLBACK no admite sentencias de control de transacción ({}). Quítalas o ejecuta la consulta normalmente.",
    "The ROLLBACK dry run does not accept transaction control statements ({1}). Remove them or run the query normally.",
  ],
  // --- eliminar ---
  ["Para eliminarlo hay que escribir su nombre exacto ({}).", "To drop it you must type its exact name ({1})."],
  ["Falta el nombre del objeto.", "The object name is missing."],
  ["Los objetos del sistema no se pueden eliminar.", "System objects cannot be dropped."],
  ["Tipo de objeto no válido.", "Invalid object type."],
  ["Falta el nombre de la base de datos.", "The database name is missing."],
  ["Las bases plantilla no se pueden eliminar.", "Template databases cannot be dropped."],
  ["La sesión está en modo solo lectura. Habilita la escritura para eliminar.", "The session is read-only. Enable writing to drop."],
  [
    "\nHyrax: otra sesión tiene bloqueado el objeto; inténtalo de nuevo cuando termine.",
    "\nHyrax: another session has the object locked; try again when it finishes.",
  ],
  ["No se pudo confirmar la transacción: {}", "Could not commit the transaction: {1}"],
  [
    "\nHyrax: hay otras conexiones abiertas a esa base (de otras aplicaciones o personas). Ciérralas o marca «Forzar» para desconectarlas.",
    "\nHyrax: there are other open connections to that database (from other applications or people). Close them or check “Force” to disconnect them.",
  ],
  // --- edición de datos ---
  ["Un valor contiene un carácter nulo (NUL), que PostgreSQL no admite.", "A value contains a null character (NUL), which PostgreSQL does not support."],
  ['La columna "{}" no existe en la tabla.', 'The column "{1}" does not exist in the table.'],
  ["La clave primaria de la fila no coincide con la de la tabla.", "The row's primary key does not match the table's."],
  ["Demasiados cambios a la vez ({}); el máximo es {}.", "Too many changes at once ({1}); the maximum is {2}."],
  ["La tabla no tiene clave primaria: no se puede editar de forma segura.", "The table has no primary key: it cannot be edited safely."],
  ["Una actualización no cambia ninguna columna.", "An update changes no column."],
  ['No se puede modificar la columna de clave primaria "{}".', 'The primary key column "{1}" cannot be modified.'],
  ['Falta el valor original de "{}" para comprobar cambios concurrentes.', 'The original value of "{1}" is missing to check for concurrent changes.'],
  [
    "La fila ya no existe o cambió desde que se cargó (otra persona la modificó). Actualiza la tabla y repite el cambio.",
    "The row no longer exists or changed since it was loaded (someone else modified it). Refresh the table and repeat the change.",
  ],
  ["La fila ya no existe. Actualiza la tabla.", "The row no longer exists. Refresh the table."],
  ["Las tablas del sistema no se pueden editar.", "System tables cannot be edited."],
  ["La tabla no existe.", "The table does not exist."],
  ["Solo se pueden editar tablas, no vistas ni tablas foráneas.", "Only tables can be edited, not views or foreign tables."],
  ["La sesión está en modo solo lectura. Habilita la escritura para aplicar cambios.", "The session is read-only. Enable writing to apply changes."],
  ["Cambio {} de {}: {} No se aplicó ningún cambio.", "Change {1} of {2}: {3} No change was applied."],
  ["Cambio {} de {}: {}\nNo se aplicó ningún cambio.", "Change {1} of {2}: {3}\nNo change was applied."],
  // --- exportar ---
  ["No se pudo escribir el archivo: {}", "Could not write the file: {1}"],
  ["La ruta de exportación debe ser absoluta.", "The export path must be absolute."],
  ["El archivo de destino debe terminar en .{}.", "The destination file must end in .{1}."],
  ["La ruta de destino es una carpeta, no un archivo.", "The destination path is a folder, not a file."],
  ["La carpeta de destino no existe.", "The destination folder does not exist."],
  ["La sentencia no devuelve filas, no hay nada que exportar.", "The statement returns no rows, there is nothing to export."],
  ["No se pudo crear el archivo: {}", "Could not create the file: {1}"],
  // --- archivos ---
  ["Tipo de archivo no válido.", "Invalid file type."],
  [
    "El archivo no está en UTF-8. Guárdalo como UTF-8 (por ejemplo, 'CSV UTF-8' en Excel) e inténtalo de nuevo.",
    "The file is not UTF-8. Save it as UTF-8 (for example, 'CSV UTF-8' in Excel) and try again.",
  ],
  ["No se pudo leer el archivo: {}", "Could not read the file: {1}"],
  ["El archivo pesa {} MB y el máximo es {} MB.", "The file weighs {1} MB and the maximum is {2} MB."],
  ["El contenido es demasiado grande para guardarlo.", "The content is too large to save."],
  ["No se pudo guardar el archivo: {}", "Could not save the file: {1}"],
  // --- importar ---
  ['La columna "{}" está asignada más de una vez.', 'The column "{1}" is assigned more than once.'],
  ['La tabla no tiene la columna "{}".', 'The table has no column "{1}".'],
  [
    "Demasiadas filas para una sola importación ({}); el máximo es {}. Divide el archivo.",
    "Too many rows for a single import ({1}); the maximum is {2}. Split the file.",
  ],
  ["La fila {} tiene {} valores y se esperaban {}.", "Row {1} has {2} values and {3} were expected."],
  ["La fila {} contiene un carácter nulo (NUL), que PostgreSQL no admite.", "Row {1} contains a null character (NUL), which PostgreSQL does not support."],
  ["La sesión está en modo solo lectura. Habilita la escritura para importar.", "The session is read-only. Enable writing to import."],
  [
    "Fila {}: se esperaba insertar 1 fila y se insertaron {}. No se importó nada.",
    "Row {1}: 1 row was expected to be inserted and {2} were. Nothing was imported.",
  ],
  ["Fila {}: {}\nNo se importó nada.", "Row {1}: {2}\nNothing was imported."],
  // --- esquema ---
  ["El objeto {}.{} no existe.", "The object {1}.{2} does not exist."],
  ["Las secuencias no tienen estructura de tabla.", "Sequences have no table structure."],
  ["Falta el identificador de la función.", "The function identifier is missing."],
  ["La función ya no existe.", "The function no longer exists."],
  // --- MongoDB ---
  ["El túnel SSH para MongoDB todavía no está disponible.", "The SSH tunnel for MongoDB is not available yet."],
  ["La dirección de MongoDB no es válida: {}", "The MongoDB address is not valid: {1}"],
  ["No se pudo crear el cliente de MongoDB: {}", "Could not create the MongoDB client: {1}"],
  ["No se pudo conectar con MongoDB: {}", "Could not connect to MongoDB: {1}"],
  ["El orden de «{}» debe ser 1 (ascendente) o -1 (descendente).", "The sort of “{1}” must be 1 (ascending) or -1 (descending)."],
  ["El nombre de la base de datos no es válido.", "The database name is not valid."],
  ["El nombre de la colección no es válido.", "The collection name is not valid."],
  ["La conexión no es de MongoDB.", "The connection is not a MongoDB one."],
  [
    "El nombre del conjunto de réplicas solo admite letras, números, punto, guion y guion bajo.",
    "The replica set name only allows letters, numbers, dot, hyphen and underscore.",
  ],
  ["Falta el puerto.", "The port is missing."],
  ["El host no es válido.", "The host is not valid."],
  ["El nodo «{}» no es válido (usa host o host:puerto).", "The node “{1}” is not valid (use host or host:port)."],
  [
    "Con mongodb+srv el host debe ser un nombre DNS (por ejemplo cluster0.abcde.mongodb.net).",
    "With mongodb+srv the host must be a DNS name (for example cluster0.abcde.mongodb.net).",
  ],
  ["Con mongodb+srv no se indican otros nodos: salen del registro DNS.", "With mongodb+srv no other nodes are given: they come from the DNS record."],
  ["directConnection no se puede usar con mongodb+srv.", "directConnection cannot be used with mongodb+srv."],
  ["Escribe el host sin puerto; el puerto va en su propio campo.", "Type the host without a port; the port goes in its own field."],
  // --- túnel SSH ---
  ["No se pudo leer el archivo de la clave privada SSH ({}): {}.", "Could not read the SSH private key file ({1}): {2}."],
  ["No se pudo usar la clave privada SSH ({}): {}. Si tiene frase de contraseña, indícala.", "Could not use the SSH private key ({1}): {2}. If it has a passphrase, enter it."],
  ["Falta el host del servidor SSH.", "The SSH server host is missing."],
  ["Falta el usuario del servidor SSH.", "The SSH server user is missing."],
  ["Tiempo agotado al conectar con el servidor SSH {}:{}.", "Timed out connecting to the SSH server {1}:{2}."],
  ["No se pudo conectar con el servidor SSH {}:{}: {}", "Could not connect to the SSH server {1}:{2}: {3}"],
  ["Tiempo agotado al autenticar en el servidor SSH.", "Timed out authenticating on the SSH server."],
  ["El servidor SSH rechazó las credenciales.", "The SSH server rejected the credentials."],
  ["Tiempo agotado al pedir al servidor SSH el reenvío hacia {}:{}.", "Timed out asking the SSH server to forward to {1}:{2}."],
  [
    "El servidor SSH no pudo reenviar hacia {}:{}: {}. Revisa el host y el puerto de Postgres (vistos desde el servidor SSH) y que AllowTcpForwarding esté permitido.",
    "The SSH server could not forward to {1}:{2}: {3}. Check the Postgres host and port (as seen from the SSH server) and that AllowTcpForwarding is allowed.",
  ],
  [
    "El servidor SSH abrió el reenvío hacia {}:{} pero lo cerró de inmediato: el destino no responde o el reenvío está restringido. Revisa el host y el puerto de Postgres (vistos desde el servidor SSH).",
    "The SSH server opened the forwarding to {1}:{2} but closed it immediately: the target does not respond or forwarding is restricted. Check the Postgres host and port (as seen from the SSH server).",
  ],
  ["No se pudo abrir el puerto local del túnel: {}", "Could not open the tunnel's local port: {1}"],
  ["Error SSH al autenticar: {}", "SSH error while authenticating: {1}"],
  ["Error SSH: {}", "SSH error: {1}"],
  // --- más mensajes ---
  ["No hay cambios que aplicar.", "There are no changes to apply."],
  ["Se esperaba afectar 1 fila y se afectaron {}.", "1 row was expected to be affected and {1} were."],
  ["No hay columnas asignadas: elige al menos una columna de destino.", "No columns are mapped: choose at least one target column."],
  ["No hay filas que importar.", "There are no rows to import."],
  ["{} es demasiado largo.", "{1} is too long."],
  ['{} debe ser un objeto JSON, por ejemplo { "campo": "valor" }.', '{1} must be a JSON object, for example { "field": "value" }.'],
  ["{} debe ser un objeto JSON.", "{1} must be a JSON object."],
  ["{} usa {}, que Hyrax no permite: ejecuta JavaScript en el servidor o escribe datos.", "{1} uses {2}, which Hyrax does not allow: it runs JavaScript on the server or writes data."],
  [
    "{} Si tu usuario solo tiene permisos sobre una base, indícala en «Base de datos» de la conexión.",
    "{1} If your user only has permissions on one database, enter it in “Database” in the connection.",
  ],
  ["{} no es JSON válido: {}", "{1} is not valid JSON: {2}"],
  ["{} tiene un tipo no válido: {}", "{1} has an invalid type: {2}"],
  // --- genéricas: van al final para no tapar a las específicas ---
  ["No se pudo borrar {}: {}", "Could not delete {1}: {2}"],
];

// Nombres que el backend antepone a otros mensajes («El filtro no es JSON válido…»).
const LABELS: [string, string][] = [
  ["El filtro", "The filter"],
  ["El orden", "The sort"],
  ["La proyección", "The projection"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile([es, en]: [string, string]): { re: RegExp; to: string } {
  const parts = es.split("{}");
  let source = "";
  parts.forEach((part, i) => {
    source += escapeRe(part);
    if (i < parts.length - 1) {
      // el último dato variable de una plantilla se lleva todo lo que quede
      const last = i === parts.length - 2 && parts[i + 1] === "";
      source += last ? "([\\s\\S]*)" : "([\\s\\S]+?)";
    }
  });
  const to = en.replace(/\$/g, "$$$$").replace(/\{(\d)\}/g, (_m, d: string) => "$" + d);
  return { re: new RegExp(source, "g"), to };
}

const COMPILED = RULES.map(compile);

/** Traduce un mensaje de error del backend al idioma actual (en español se devuelve tal cual). */
export function translateBackend(text: string): string {
  if (getLang() !== "en") return text;
  let out = text;
  for (const { re, to } of COMPILED) out = out.replace(re, to);
  for (const [es, en] of LABELS) out = out.split(es).join(en);
  return out;
}
