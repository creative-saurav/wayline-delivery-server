const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 3000;

// Firebase Admin SDK
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const decoded = Buffer
    .from(process.env.FB_SERVICE_KEY, "base64")
    .toString("utf8");

const serviceAccount = JSON.parse(decoded);

initializeApp({
    credential: cert(serviceAccount)
});
// Firebase Admin SDK

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.bvw1g5i.mongodb.net/?appName=Cluster0`;

// Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Middleware
const verifyFBtoken = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).send({ message: 'Unauthorization Access' })
    }
    try {
        const idToken = token.split(" ")[1];
        const decodedToken = await getAuth().verifyIdToken(idToken);
        req.decoded_email = decodedToken.email;
        next();
    }
    catch (error) {
        return res.status(401).send({
            message: "Unauthorized access"
        });
    }
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// ---- MongoDB collections (assigned once connect() resolves) ----
let usersCollection, parcelsCollection, paymentsCollection, ridersCollection, trackingsCollection;

// This promise is awaited at the top of every route handler below,
// so a request that arrives before the DB is ready simply waits
// instead of hitting an unregistered route (this was the original bug).
const dbConnectionPromise = client.connect()
    .then(() => {
        const db = client.db('zap_shifting');
        usersCollection = db.collection('users');
        parcelsCollection = db.collection('parcels');
        paymentsCollection = db.collection('payments');
        ridersCollection = db.collection('riders');
        trackingsCollection = db.collection('trackings');
        // console.log('MongoDB connected successfully');
    })
    .catch((error) => {
        console.error('MongoDB connection failed:', error);
        throw error;
    });

// Ensures the DB is connected before a route handler touches any collection.
const ensureDbConnected = async (req, res, next) => {
    try {
        await dbConnectionPromise;
        next();
    } catch (error) {
        return res.status(500).send({ message: 'Database connection failed', error: error.message });
    }
};

// Apply to every route that needs the database.
app.use(ensureDbConnected);

//Middleware More Activity admin Must Be used verifyFBtoken
const verifyAdmin = async (req, res, next) => {
    const email = req.decoded_email;
    const query = { email };
    const user = await usersCollection.findOne(query);
    if (user?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden Access.' });
    }
    next();
}
const verifyRider = async (req, res, next) => {
    const email = req.decoded_email;
    const query = { email };
    const user = await usersCollection.findOne(query);
    if (user?.role !== 'rider') {
        return res.status(403).send({ message: 'Forbidden Access.' });
    }
    next();
}

const logtracking = async (trackingId, status) => {
    const log = {
        trackingId,
        status,
        detail: status.split('-').join(' '),
        createdAt: new Date()
    }
    const result = await trackingsCollection.insertOne(log);
    return result;
}

app.get('/', (req, res) => {
    res.send('Zap Shifting Server is running!');
});

//User Api
app.get('/users', verifyFBtoken, verifyAdmin, async (req, res) => {
    const searchText = req.query.searchText;
    const query = {};
    if (searchText) {
        query.$or = [
            { displayName: { $regex: searchText, $options: 'i' } },
            { email: { $regex: searchText, $options: 'i' } }
        ]
    }
    const cursor = usersCollection.find(query).sort({ createdAt: -1 });
    const result = await cursor.toArray();
    res.send(result);
})

app.post('/users', async (req, res) => {
    const user = req.body;
    user.role = 'user';
    user.createdAt = new Date();

    const email = user.email;
    const existUser = await usersCollection.findOne({ email });
    if (existUser) {
        return res.send({ message: 'Already Exist.' })
    }

    const result = await usersCollection.insertOne(user);
    res.send(result);
})

app.patch('/users/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const updatedDoc = {
        $set: {
            displayName: req.body.displayName,
            photoURL: req.body.photoURL,
            role: req.body.role,
            phone: req.body.phone,
            address: req.body.address,
            dateOfBirth: req.body.dateOfBirth,
            gender: req.body.gender,
            bio: req.body.bio,
        }
    }
    const result = await usersCollection.updateOne(query, updatedDoc);
    res.send(result);
})

app.get('/users/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await usersCollection.findOne(query);
    res.send(result);
})

app.delete('/users/:id', verifyFBtoken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await usersCollection.deleteOne(query);
    res.send(result);
})

//User Role Api
app.get('/users/:email/role', async (req, res) => {
    const email = req.params.email;
    const query = { email };
    const user = await usersCollection.findOne(query);
    res.send({ role: user?.role || 'user' });
})

//Riders Api
app.get('/riders', verifyFBtoken, verifyAdmin, async (req, res) => {
    const query = {};
    const { status, workStatus, district } = req.query;
    if (status) {
        query.status = status
    }
    if (workStatus) {
        query.workStatus = workStatus
    }
    if (district) {
        query.riderDistrict = district
    }

    const cursor = ridersCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
})

//Riders Dashboard Api
app.get('/riders/delivery-per-days', async (req, res) => {
    const email = req.query.email;
    const pipeline = [
        {
            $match: {
                riderEmail: email,
                deliveryStatus: "delivered"
            }
        },
        {
            $lookup: {
                from: "trackings",
                localField: "trackingId",
                foreignField: 'trackingId',
                as: 'parcel_tracknings'
            }
        },
        {
            $unwind: "$parcel_tracknings"
        },
        {
            $match: {
                'parcel_tracknings.status': 'delivered'
            }
        },
        {
            $addFields: {
                deliveryDay: {
                    $dateToString: {
                        format: "%Y-%m-%d",
                        date: '$parcel_tracknings.createdAt'
                    }
                }
            }
        },
        {
            $group: {
                _id: "$deliveryDay",
                deliveryCount: { $sum: 1 }
            }
        }
    ]
    const result = await parcelsCollection.aggregate(pipeline).toArray();
    res.send(result);
})

//Customer Dashboard Api
app.get('/customer/dashboard', async (req, res) => {
    const email = req.query.email;

    const pipeline = [
        {
            $match: {
                senderEmail: email
            }
        },
        {
            $facet: {
                stats: [
                    {
                        $group: {
                            _id: null,
                            totalParcels: { $sum: 1 },
                            pending: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$deliveryStatus', ['parcel-created', 'pending-pickup']] },
                                        1,
                                        0
                                    ]
                                }
                            },
                            active: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$deliveryStatus', ['rider-accepted', 'parcel-picked-up', 'out-for-delivery']] },
                                        1,
                                        0
                                    ]
                                }
                            },
                            delivered: {
                                $sum: {
                                    $cond: [{ $eq: ['$deliveryStatus', 'delivered'] }, 1, 0]
                                }
                            }
                        }
                    }
                ],
                recentParcels: [
                    { $sort: { createdAt: -1 } },
                    { $limit: 5 },
                    {
                        $project: {
                            _id: 1,
                            parcelName: 1,
                            trackingId: 1,
                            deliveryStatus: 1,
                            paymentStatus: 1,
                            cost: 1,
                            createdAt: 1
                        }
                    }
                ]
            }
        }
    ];

    const result = await parcelsCollection.aggregate(pipeline).toArray();

    res.send({
        stats: result[0]?.stats[0] || {
            totalParcels: 0,
            pending: 0,
            active: 0,
            delivered: 0
        },
        recentParcels: result[0]?.recentParcels || []
    });
});

app.post('/riders', verifyFBtoken, async (req, res) => {
    const rider = req.body;
    rider.status = 'pending';
    rider.createdAt = new Date();
    const result = await ridersCollection.insertOne(rider);
    res.send(result);
})

app.patch('/riders/:id', verifyFBtoken, verifyAdmin, async (req, res) => {
    const status = req.body.status;
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const updatedDoc = {
        $set: {
            status: status,
            workStatus: 'available'
        }
    }
    const result = await ridersCollection.updateOne(query, updatedDoc);

    if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email: email };
        const updatedUser = {
            $set: {
                role: 'rider'
            }
        }
        await usersCollection.updateOne(userQuery, updatedUser);
    }
    res.send(result);
})

app.get('/riders/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await ridersCollection.findOne(query);
    res.send(result);
})

app.delete('/riders/:id', verifyFBtoken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await ridersCollection.deleteOne(query);
    res.send(result);
})

//Parcel API
app.get('/parcels', verifyFBtoken, async (req, res) => {
    const query = {};
    const { email, deliveryStatus } = req.query;

    if (email) {
        query.senderEmail = email;
    }
    if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
    }

    const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
    const result = await cursor.toArray();
    res.send(result);
})

//Parcels Api Aggregation for dashboard
app.get('/parcels/delivery-status/states', async (req, res) => {
    const pipeline = [
        {
            $group: {
                _id: "$deliveryStatus",
                count: { $sum: 1 }
            }
        },
    ]
    const result = await parcelsCollection.aggregate(pipeline).toArray();
    res.send(result);
})

//Parcels Rider Api
app.get('/parcels/rider', async (req, res) => {
    const { riderEmail, deliveryStatus } = req.query;
    const query = {};
    if (riderEmail) {
        query.riderEmail = riderEmail;
    }
    if (deliveryStatus !== 'delivered') {
        query.deliveryStatus = { $nin: ['delivered'] };
    } else {
        query.deliveryStatus = deliveryStatus;
    }

    const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
    const result = await cursor.toArray();
    res.send(result);
})

//Riders Parcel Approve and Reject Api
app.patch('/parcels/:id/status', verifyFBtoken, async (req, res) => {
    const id = req.params.id;
    const { status, riderId, trackingId } = req.body;
    const query = { _id: new ObjectId(id) };
    let updatedDoc;
    if (status === 'rejected') {
        updatedDoc = {
            $set: {
                deliveryStatus: 'pending-pickup'
            },
            $unset: {
                riderId: "",
                riderName: "",
                riderEmail: ""
            }
        };
    } else {
        updatedDoc = {
            $set: {
                deliveryStatus: status
            }
        };
    }

    const result = await parcelsCollection.updateOne(query, updatedDoc);

    if (status !== 'rejected') {
        logtracking(trackingId, status);
    }

    if (status === 'delivered' || status === 'rejected') {
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdate = {
            $set: {
                workStatus: 'available'
            }
        }
        await ridersCollection.updateOne(riderQuery, riderUpdate);
    }

    res.send(result);
})

app.post('/parcels', verifyFBtoken, async (req, res) => {
    const parcel = req.body;
    const trackingId = `ZP-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    parcel.createdAt = new Date();
    parcel.trackingId = trackingId;
    parcel.deliveryStatus = 'parcel-created';

    logtracking(trackingId, 'parcel-created');

    const result = await parcelsCollection.insertOne(parcel);
    res.send(result);
})

app.get('/parcels/:id', verifyFBtoken, async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await parcelsCollection.findOne(query);
    res.send(result);
})

//Assign Rider Api
app.patch('/parcels/:id', verifyFBtoken, async (req, res) => {
    const { riderId, riderName, riderEmail } = req.body;
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const updatedDoc = {
        $set: {
            deliveryStatus: 'driver-assigned',
            riderId: riderId,
            riderName: riderName,
            riderEmail: riderEmail
        }
    }
    await parcelsCollection.updateOne(query, updatedDoc);

    const riderQuery = { _id: new ObjectId(riderId) };
    const riderUpdate = {
        $set: {
            workStatus: 'in-delivery'
        }
    }
    const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdate);

    res.send(riderResult);
})

app.delete('/parcels/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await parcelsCollection.deleteOne(query);
    res.send(result);
})

//Tracking Api Log Client Side
app.get('/trackings/:trackingId/log', async (req, res) => {
    const trackingId = req.params.trackingId;
    const query = { trackingId };
    const cursor = trackingsCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
})

//Stripe Payment Api
app.post('/create-stripe-checkout-session', async (req, res) => {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.cost * 100);

    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: 'USD',
                    unit_amount: amount,
                    product_data: {
                        name: paymentInfo.parcelName,
                    }
                },
                quantity: 1,
            },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
            trackingId: paymentInfo.trackingId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
    })
    res.send({ url: session.url });
})

//Payment Success Api
app.patch('/payment-success', async (req, res) => {
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const transactionId = session.payment_intent;
    const query = { transactionId: transactionId };

    const paymentExist = await paymentsCollection.findOne(query);
    if (paymentExist) {
        return res.send({
            message: 'Already Exist.',
            transactionId,
            trackingId: paymentExist.trackingId
        })
    }

    const trackingId = session.metadata.trackingId;

    if (session.payment_status === 'paid') {
        const parcelId = session.metadata.parcelId;
        const filter = { _id: new ObjectId(parcelId) };
        const update = {
            $set: {
                paymentStatus: 'paid',
                paymentDate: new Date(),
                trackingId: trackingId,
                deliveryStatus: 'pending-pickup'
            }
        }
        const result = await parcelsCollection.updateOne(filter, update);

        const payment = {
            parcelId: session.metadata.parcelId,
            parcelName: session.metadata.parcelName,
            senderEmail: session.customer_email,
            amount: session.amount_total / 100,
            currency: session.currency,
            paymentMethod: 'stripe',
            transactionId: transactionId,
            paymentDate: new Date(),
            trackingId: trackingId,
        }

        const resultPayment = await paymentsCollection.insertOne(payment);
        logtracking(trackingId, 'pending-pickup');

        return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: transactionId,
            paymentInfo: resultPayment
        });
    }

    return res.send({ success: false });
})

//Payment History
app.get('/payments-history', verifyFBtoken, async (req, res) => {
    const query = {};
    const email = req.query.email;

    if (email) {
        query.senderEmail = email;

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'Forbidden Access.' })
        }
    }
    const payments = await paymentsCollection
        .find(query)
        .sort({ paymentDate: -1 })
        .toArray();

    const result = await Promise.all(
        payments.map(async (payment) => {
            const parcel = await parcelsCollection.findOne({
                _id: new ObjectId(payment.parcelId)
            });
            return {
                ...payment,
                receiverName: parcel?.receiverName,
                receiverAddress: parcel?.reciverAddress,
                receiverPhone: parcel?.receiverPhone,
                reciverRegion: parcel?.reciverRegion,
                reciverDistrict: parcel?.reciverDistrict
            };
        })
    );

    res.send(result);
})

// Only run a traditional listening server for local development.
// On Vercel, the exported `app` is used directly as a serverless function.
if (process.env.VERCEL !== '1') {
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}

module.exports = app;