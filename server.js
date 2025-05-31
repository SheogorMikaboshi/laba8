require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Подключение к MongoDB
const mongoUri = process.env.MONGO_URI || "mongodb+srv://admin:228565@repairworks.exoy7l9.mongodb.net/?retryWrites=true&w=majority&appName=repairworks";
let db;

async function connectDB() {
  const client = new MongoClient(mongoUri);
  await client.connect();
  db = client.db('repairworks');
  console.log('Connected to MongoDB');
  
  // Инициализация начальных данных (если коллекции пустые)
  await initializeData();
}

async function initializeData() {
  // Проверяем и добавляем тестовые данные, если коллекции пустые
  const collections = {
    users: [
      { login: 'admin', password: bcrypt.hashSync('admin', 10), root: true },
      { login: 'user1', password: bcrypt.hashSync('user1', 10), root: false }
    ],
    clients: [
      { name: 'Иванов Иван', contact: 'ivanov@example.com' },
      { name: 'Петров Петр', contact: 'petrov@example.com' }
    ],
    contractors: [
      { name: 'ООО "СтройМастер"', contact: 'stroy@example.com' },
      { name: 'ИП Сидоров', contact: 'sidorov@example.com' }
    ],
    materials: [
      { name: 'Краска', cost: 1500 },
      { name: 'Обои', cost: 2500 },
      { name: 'Ламинат', cost: 3000 }
    ],
    objects: [
      { type: 'Квартира', address: 'ул. Ленина, 10', area: 50 },
      { type: 'Офис', address: 'ул. Гагарина, 5', area: 100 }
    ],
    orders: []
  };

  for (const [collectionName, defaultData] of Object.entries(collections)) {
    const count = await db.collection(collectionName).countDocuments();
    if (count === 0 && defaultData.length > 0) {
      await db.collection(collectionName).insertMany(defaultData);
      console.log(`Initialized ${collectionName} with default data`);
    }
  }
}

// Middleware
app.use(express.static(path.join(__dirname, 'static')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SECRET_KEY || 'your-secret-key-here',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Для production используйте secure: true с HTTPS
}));

// Проверка аутентификации
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/login.html');
  }
  next();
};

// Проверка прав администратора
const requireAdmin = (req, res, next) => {
  if (!req.session.user?.is_admin) {
    return res.status(403).send('Доступ запрещен');
  }
  next();
};

// Роуты
app.get('/', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// API для получения данных
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const data = {
      user: req.session.user,
      clients: await db.collection('clients').find().toArray(),
      contractors: await db.collection('contractors').find().toArray(),
      materials: await db.collection('materials').find().toArray(),
      objects: await db.collection('objects').find().toArray(),
      users: await db.collection('users').find({ root: false }).toArray()
    };

    if (req.session.user.is_admin) {
      data.orders = await db.collection('orders').find().toArray();
    } else {
      data.orders = await db.collection('orders').find({
        $or: [
          { "user_id": req.session.user._id },
          { "assigned_user_id": req.session.user._id }
        ]
      }).toArray();
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Аутентификация
app.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await db.collection('users').findOne({ login });

    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.user = {
        _id: user._id.toString(),
        login: user.login,
        is_admin: user.root || false
      };
      return res.json({ success: true });
    }

    res.status(401).json({ error: 'Неверный логин или пароль' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Ошибка выхода');
    }
    res.redirect('/login.html');
  });
});

// Создание заказа
app.post('/create_order', requireAuth, async (req, res) => {
  try {
    const { client_id, contractor_id, object_id, user_id, materials } = req.body;

    // Проверка обязательных полей
    if (!client_id || !contractor_id || !object_id || !user_id) {
      return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
    }

    // Получаем данные
    const [client, contractor, object, assignedUser] = await Promise.all([
      db.collection('clients').findOne({ _id: new ObjectId(client_id) }),
      db.collection('contractors').findOne({ _id: new ObjectId(contractor_id) }),
      db.collection('objects').findOne({ _id: new ObjectId(object_id) }),
      db.collection('users').findOne({ _id: new ObjectId(user_id) })
    ]);

    if (!client || !contractor || !object || !assignedUser) {
      return res.status(400).json({ error: 'Неверные данные в заказе' });
    }

    // Получаем материалы
    const materialsList = [];
    let cost = object.area * 1000; // Базовая стоимость

    if (materials && materials.length > 0) {
      const materialItems = await db.collection('materials')
        .find({ _id: { $in: materials.map(id => new ObjectId(id)) } })
        .toArray();

      for (const material of materialItems) {
        materialsList.push(material.name);
        cost += material.cost;
      }
    }

    // Сохраняем заказ
    const order = {
      client,
      contractor,
      object,
      materials: materialsList,
      cost,
      user_id: req.session.user._id,
      assigned_user_id: user_id,
      created_at: new Date().toISOString(),
      status: 'new'
    };

    const result = await db.collection('orders').insertOne(order);
    order._id = result.insertedId;

    res.json({ success: true, order });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Ошибка при создании заказа' });
  }
});

// Удаление заказа
app.delete('/delete_order/:order_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { order_id } = req.params;
    const result = await db.collection('orders').deleteOne({ _id: new ObjectId(order_id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete order error:', err);
    res.status(500).json({ error: 'Ошибка при удалении заказа' });
  }
});

// CRUD операции для других сущностей (клиенты, подрядчики и т.д.)
// Добавьте по аналогии при необходимости

// Обработка 404
app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).send('Ошибка сервера');
});

// Запуск сервера
connectDB().then(() => {
  app.listen(port, () => {
    console.log(`Сервер запущен на http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
