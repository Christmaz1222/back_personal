const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const pool = require('./db'); // Nuestra conexión a la BD
const xlsx = require('xlsx'); // ¡NUEVO! Para leer Excel
const fs = require('fs'); // ¡NUEVO! Para manejar archivos

const app = express();
const port = 3001;

// --- Middlewares ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Configuración de Multer (Manejo de Archivos) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // La carpeta 'uploads' debe existir
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// ==========================================================
// --- RUTA 1: Importar Funcionarios desde Excel (POST) ---
// ==========================================================
// upload.single('archivo') espera un campo 'archivo'
app.post('/api/funcionarios/importar', upload.single('archivo'), async (req, res) => {

  // 1. Verificamos que se subió un archivo
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo.' });
  }

  const rutaArchivo = req.file.path;

  // Usamos un cliente de la pool para manejar la transacción
  const client = await pool.connect();

  try {
    // 2. Leer el archivo Excel
    const workbook = xlsx.readFile(rutaArchivo);
    const sheetName = workbook.SheetNames[0]; // Tomamos la primera hoja
    const worksheet = workbook.Sheets[sheetName];
    
    // 3. Convertir la hoja a JSON
    // IMPORTANTE: Los nombres en la cabecera del Excel deben coincidir
    // con los nombres de las columnas en la BD (en minúsculas).
    // Ej: en Excel debe decir 'ci', 'paterno', 'grado', 'unidad_destino'
    const datos = xlsx.utils.sheet_to_json(worksheet);

    if (datos.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel está vacío.' });
    }

    // 4. Iniciar Transacción (TODO O NADA)
    await client.query('BEGIN');

    // 5. Preparar la consulta SQL
    const consulta = `
      INSERT INTO personal (
        ci, comp, paterno, materno, nombres, escalafon, 
        grado, proceso, cargo, unidad, destino, celular
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;

    // 6. Recorrer los datos del Excel e insertarlos
    for (const fila of datos) {
      const valores = [
        fila.ci,
        fila.comp,
        fila.paterno,
        fila.materno,
        fila.nombres,
        fila.escalafon,
        fila.grado,
        fila.proceso,
        fila.cargo,
        fila.unidad,
        fila.destino,
        fila.celular
      ];
      await client.query(consulta, valores);
    }

    // 7. Si todo salió bien, confirmar la transacción
    await client.query('COMMIT');

    res.status(201).json({ message: `¡Éxito! Se importaron ${datos.length} personal.` });

  } catch (err) {
    // 8. Si algo falló, deshacer todo
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Error en la importación. Se revirtieron los cambios.', detalle: err.message });
  
  } finally {
    // 9. Liberar el cliente y borrar el archivo temporal
    client.release();
    fs.unlinkSync(rutaArchivo); // Borra el archivo de /uploads
  }
});

// =================================================================
// --- RUTA 2: Consumir los datos (para el dashboard u otro sistema) ---
// =================================================================
app.get('/api/funcionarios', async (req, res) => {
  try {
    const todosLosRegistros = await pool.query("SELECT * FROM personal ORDER BY paterno, materno, nombres");
    res.json(todosLosRegistros.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor');
  }
});

// --- Iniciar el servidor ---
app.listen(port, () => {
  console.log(`Backend corriendo en http://localhost:${port}`);
});
// =================================================================
// --- RUTA 3: Buscar funcionario por CI y COMP (CORREGIDO) ---
// =================================================================
app.get('/api/funcionarios/buscar/identidad', async (req, res) => {
  try {
    const { ci, comp } = req.query; // Se leerá de la URL: ?ci=123456&comp=LP

    if (!ci) {
      return res.status(400).json({ error: 'El parámetro "ci" es obligatorio.' });
    }

    // 1. Empezamos la consulta solo con CI
    let queryText = 'SELECT * FROM personal WHERE ci = $1';
    let queryParams = [ci];

    // 2. SOLO si el usuario nos manda un 'comp', lo añadimos
    if (comp) {
      if (comp.toLowerCase() === 'null') {
        // Si el usuario busca explícitamente ?comp=null
        queryText += ' AND comp IS NULL';
      } else {
        // Si busca un complemento específico (ej. ?comp=LP)
        queryText += ' AND comp = $2';
        queryParams.push(comp);
      }
    }
    // Si 'comp' no viene en la URL, la consulta se queda solo con el CI.

    const resultado = await pool.query(queryText, queryParams);

    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'No se encontró ningún funcionario con ese CI/COMP.' });
    }

    // Devolvemos un array, ya que un CI podría tener varios 'comp' (ej. 123 LP, 123 CB)
    res.json(resultado.rows); 

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor');
  }
});
// =================================================================
// --- RUTA 4: Buscar por Nombres, Paterno y/o Unidad (Flexible) ---
// =================================================================
app.get('/api/funcionarios/buscar/nombre', async (req, res) => {
  try {
    // Leemos los 3 posibles parámetros de la URL
    const { paterno, nombres, unidad } = req.query; 

    if (!paterno && !nombres && !unidad) {
      return res.status(400).json({ 
        error: 'Debe proveer al menos "paterno", "nombres" o "unidad" para la búsqueda.' 
      });
    }

    let queryText = 'SELECT * FROM personal WHERE 1=1'; // Consulta base
    let queryParams = [];
    let paramIndex = 1;

    // --- Añadimos los filtros dinámicamente ---

    if (paterno) {
      // ILIKE ignora mayúsculas/minúsculas
      queryText += ` AND paterno ILIKE $${paramIndex++}`;
      queryParams.push(`%${paterno}%`); // Los % buscan coincidencias parciales
    }

    if (nombres) {
      queryText += ` AND nombres ILIKE $${paramIndex++}`;
      queryParams.push(`%${nombres}%`);
    }
    
    // ¡NUEVO FILTRO!
    if (unidad) {
      // Asumimos que la columna se llama 'unidad_destino'
      queryText += ` AND unidad ILIKE $${paramIndex++}`; 
      queryParams.push(`%${unidad}%`);
    }

    queryText += ' ORDER BY paterno, materno, nombres'; // Ordenamos el resultado
    
    const resultado = await pool.query(queryText, queryParams);

    res.json(resultado.rows); // Devuelve todos los que coincidan

  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error en el servidor');
  }
});