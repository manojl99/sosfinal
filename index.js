const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { check, validationResult } = require('express-validator');
const winston = require('winston');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const port = 3000;

// Native Notify configuration
const NATIVE_NOTIFY_API_URL = 'https://app.nativenotify.com/api/notification';
const NATIVE_NOTIFY_APP_ID = '23151';
const NATIVE_NOTIFY_APP_TOKEN = 'zaFxawdeQ9Y1PqSuGKdMMo';

// In-memory stores
const userLocations = new Map(); // To store user locations
const sosPressCount = new Map();  // To store SOS press counts

// Middleware
app.use(bodyParser.json());
app.use(cors()); // Allow cross-origin requests

// Setup logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Haversine formula to calculate distance between two points (in kilometers)
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
};

// Helper function for sending notifications with retry logic
const sendNotification = async (user, message, latitude, longitude, screen) => {
  const maxRetries = 10;
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
          screen  // Specify the screen to navigate to
        }
      });
      logger.info(`Notification sent to user ${user}: ${response.status}`);
      return; // Exit on success
    } catch (error) {
      logger.error(`Error sending notification to user ${user} on attempt ${attempt}: ${error.message}`);
      if (attempt === maxRetries) {
        logger.error(`Failed to send notification to user ${user} after ${maxRetries} attempts.`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retrying
    }
  }
};

// Route for SOS button press
app.post('/sos', [
  check('userId').isString().notEmpty(),
  check('latitude').isFloat({ min: -90, max: 90 }),
  check('longitude').isFloat({ min: -180, max: 180 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: 'Invalid request data', errors: errors.array() });
  }

  const { userId, latitude, longitude } = req.body;

  // Create the message and data to send
  const googleMapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
  const message = `Help! I'm in danger. My current location is:\nLatitude: ${latitude}\nLongitude: ${longitude}\n[Open in Google Maps](${googleMapsLink})`;

  // Track SOS button presses
  const currentPressCount = sosPressCount.get(userId) || 0;
  sosPressCount.set(userId, currentPressCount + 1);

  // Get nearby users based on the latest stored location
  const nearbyUsers = [];
  for (const [otherUserId, location] of userLocations) {
    const distance = haversineDistance(latitude, longitude, location.latitude, location.longitude);
    if (distance <= 5) { // 5 kilometers radius
      nearbyUsers.push(otherUserId);
    }
  }

  if (nearbyUsers.length === 0) {
    logger.info('No nearby users to notify.');
  }

  try {
    // Send push notification via Native Notify to nearby users
    const notifications = nearbyUsers.map(user =>
      sendNotification(user, message, latitude, longitude, 'HelpScreen')  // Pass screen name here
    );
    await Promise.all(notifications);

    // Emit SOS alert to nearby users via Socket.IO
    io.emit('sosAlert', { userId, latitude, longitude, message });

    logger.info(`SOS notifications sent to ${nearbyUsers.length} users.`);

    res.json({
      status: 'success',
      message: 'SOS signal sent successfully.',
      notificationsSent: nearbyUsers.length, // Number of notifications sent
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
app.post('/location', [
  check('userId').isString().notEmpty(),
  check('latitude').isFloat({ min: -90, max: 90 }),
  check('longitude').isFloat({ min: -180, max: 180 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: 'Invalid request data', errors: errors.array() });
  }

  const { userId, latitude, longitude } = req.body;

  // Update the location data
  userLocations.set(userId, { latitude, longitude });

  logger.info(`Received location update from user ${userId}: Latitude ${latitude}, Longitude ${longitude}`);

  // Emit location update to all connected clients
  io.emit('locationUpdate', { userId, latitude, longitude });

  // Respond with success
  res.json({
    status: 'success',
    message: 'Location data received successfully.',
  });
});

// Create HTTP server and integrate with Socket.IO
const server = http.createServer(app);
const io = socketIo(server);

// Socket.IO event handlers
io.on('connection', (socket) => {
  logger.info('A client connected:', socket.id);

  socket.on('disconnect', () => {
    logger.info('A client disconnected:', socket.id);
  });

  // Listen for custom events if needed
  socket.on('customEvent', (data) => {
    logger.info('Received custom event:', data);
  });
});

// Start the server
server.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});
