const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { check, validationResult } = require('express-validator');
const winston = require('winston');

const app = express();

// Native Notify configuration (replace these with your actual API keys if needed)
const NATIVE_NOTIFY_API_URL = 'https://app.nativenotify.com/api/notification';
const NATIVE_NOTIFY_APP_ID = '23151';
const NATIVE_NOTIFY_APP_TOKEN = 'zaFxawdeQ9Y1PqSuGKdMMo';

// In-memory stores (Note: These will reset on each function invocation)
const userLocations = new Map();
const sosPressCount = new Map();

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Setup logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' }) // Adjust the path as needed
  ]
});

// Haversine formula to calculate distance between two points (in kilometers)
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Helper function for sending notifications with retry logic
const sendNotification = async (user, message, latitude, longitude, screen) => {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(NATIVE_NOTIFY_API_URL, {
        appId: NATIVE_NOTIFY_APP_ID,
        appToken: NATIVE_NOTIFY_APP_TOKEN,
        title: 'SOS Alert',
        body: message,
        pushData: {
          type: 'SOS',
          latitude,
          longitude,
          screen
        }
      });
      logger.info(`Notification sent to user ${user}: ${response.status}`);
      return;
    } catch (error) {
      logger.error(`Error sending notification to user ${user} on attempt ${attempt}: ${error.message}`);
      if (attempt === maxRetries) {
        logger.error(`Failed to send notification to user ${user} after ${maxRetries} attempts.`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

// Route for SOS button press
app.post('/api/sos', [
  check('userId').isString().notEmpty(),
  check('latitude').isFloat({ min: -90, max: 90 }),
  check('longitude').isFloat({ min: -180, max: 180 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: 'Invalid request data', errors: errors.array() });
  }

  const { userId, latitude, longitude } = req.body;

  const googleMapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const message = `Help! I'm in danger. My current location is:\nLatitude: ${latitude}\nLongitude: ${longitude}\n[Open in Google Maps](${googleMapsLink})`;

  const currentPressCount = sosPressCount.get(userId) || 0;
  sosPressCount.set(userId, currentPressCount + 1);

  const nearbyUsers = [];
  for (const [otherUserId, location] of userLocations) {
    const distance = haversineDistance(latitude, longitude, location.latitude, location.longitude);
    if (distance <= 5) {
      nearbyUsers.push(otherUserId);
    }
  }

  if (nearbyUsers.length === 0) {
    logger.info('No nearby users to notify.');
  }

  try {
    const notifications = nearbyUsers.map(user =>
      sendNotification(user, message, latitude, longitude, 'HelpScreen')
    );
    await Promise.all(notifications);

    logger.info(`SOS notifications sent to ${nearbyUsers.length} users.`);

    res.json({
      status: 'success',
      message: 'SOS signal sent successfully.',
      notificationsSent: nearbyUsers.length,
    });
  } catch (error) {
    logger.error('Error sending push notification:', {
      message: error.message,
      response: error.response ? error.response.data : null,
      request: error.request ? error.request : null,
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to send push notification.',
      error: error.message
    });
  }
});

// Route for continuous location updates
app.post('/api/location', [
  check('userId').isString().notEmpty(),
  check('latitude').isFloat({ min: -90, max: 90 }),
  check('longitude').isFloat({ min: -180, max: 180 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: 'Invalid request data', errors: errors.array() });
  }

  const { userId, latitude, longitude } = req.body;

  userLocations.set(userId, { latitude, longitude });

  logger.info(`Received location update from user ${userId}: Latitude ${latitude}, Longitude ${longitude}`);

  res.json({
    status: 'success',
    message: 'Location data received successfully.',
  });
});

// Route to get nearby users
app.get('/api/nearby-users', (req, res) => {
  // Assuming you want to return users within a fixed radius (e.g., 5 km) from a central point
  // You could add parameters to the request to customize this behavior
  const { latitude, longitude } = req.query;

  if (!latitude || !longitude) {
    return res.status(400).json({ status: 'error', message: 'Latitude and longitude are required.' });
  }

  const nearbyUsers = [];
  for (const [userId, location] of userLocations) {
    const distance = haversineDistance(latitude, longitude, location.latitude, location.longitude);
    if (distance <= 5) { // 5 km radius
      nearbyUsers.push({
        userId,
        latitude: location.latitude,
        longitude: location.longitude,
      });
    }
  }

  res.json(nearbyUsers);
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start the server
const PORT = 3000; // You can change this to any port you prefer
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
