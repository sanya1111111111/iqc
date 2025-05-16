const http = require("http");
const mysql = require("mysql2");
const util = require("util");

const pool = mysql.createPool({
    connectionLimit: 25,
    host: "localhost",
    port: "3306",
    user: "user1",
    password: "iHateCMD!1",
    database: "mydb"
});

const query = util.promisify(pool.query).bind(pool);

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(err);
            }
        });
    });
}

async function authorizeUser(login, pass) {
    const results = await query("SELECT iduser FROM user WHERE login = ? AND password = ?", [login, pass]);
    return results.length > 0 ? results[0].iduser : null;
}

setInterval(async () => {
    const timeoutSeconds = 10;
    const threshold = new Date(Date.now() - timeoutSeconds * 1000 * 60);

    const result = await query(
        `DELETE FROM user_list WHERE last_ping < ?`, [threshold]
    );
    console.log(`Cleanup: removed ${result.affectedRows} inactive users.`);
}, 5000);

function sendError(res, code, msg = "") {
    res.statusCode = code;
    res.end(msg);
}

http.createServer(async (request, response) => {
    let dataJson;

    try {
        dataJson = await parseRequestBody(request);
    } catch (err) {
        return sendError(response, 400, "Invalid JSON");
    }

    const { url } = request;

    try {
        switch (url) {
            case "/create_user": {
                const { login, pass } = dataJson;
                const existing = await query("SELECT iduser FROM user WHERE login = ?", [login]);
                if (existing.length > 0) return sendError(response, 403);
                await query("INSERT INTO user (login, password) VALUES (?, ?)", [login, pass]);
                return response.end();
            }

            case "/authorise_user": {
                const { login, pass } = dataJson;
                const userId = await authorizeUser(login, pass);
                if (!userId) return sendError(response, 403);
                return response.end();
            }

            case "/create_room": {
                const { login, pass, tags, img, roomPass, roomName } = dataJson;
                if (!login || !pass || !tags || !img || !roomPass || !roomName) return sendError(response, 400);

                const userId = await authorizeUser(login, pass);
                if (!userId) return sendError(response, 403);

                const mapRes = await query("INSERT INTO map (maptag, mapimg) VALUES (?, ?)", [tags, img]);
                const roomRes = await query("INSERT INTO room (admin, map, password, name) VALUES (?, ?, ?, ?)", [userId, mapRes.insertId, roomPass, roomName]);
                const now = new Date();
                await query("INSERT INTO user_list (user, room, is_admin, last_ping) VALUES (?, ?, 1, ?)", [userId, roomRes.insertId, now]);

                return response.end();
            }

            case "/join_room": {
                const { login, pass, roomName, roomPassword } = dataJson;
                const userId = await authorizeUser(login, pass);
                if (!userId) return sendError(response, 403);

                const roomResults = await query("SELECT * FROM room JOIN map ON room.map = map.idmap WHERE name = ? AND password = ?", [roomName, roomPassword]);
                if (roomResults.length === 0) return sendError(response, 404);

                const room = roomResults[0];
                const now = new Date();

                const userExist = await query("SELECT * FROM user_list where user = ? and room = ?", [userId ,room.idroom]);
                if (userExist.length <= 0) await query("INSERT INTO user_list (user, room, is_admin, last_ping) VALUES (?, ?, 0, ?)", [userId, room.idroom, now]);

                const usersRes = await query("SELECT * FROM user JOIN user_list ON user.iduser = user_list.user WHERE room = ?", [room.idroom]);
                if (usersRes.length === 0) return sendError(response, 404);
                const users = usersRes.map(u => u.login);
                const admin = usersRes.find(u => u.iduser === room.admin);

                response.setHeader("map-img", room.mapimg);
                response.setHeader("map-tag", encodeURI(room.maptag));
                response.setHeader("users", JSON.stringify(users));
                response.setHeader("creator", admin.login);
                return response.end();
            }

            case "/request_room_update": {
                const { login, pass, roomName, latitude, longitude, quests } = dataJson;

                console.log(`${login} ${roomName}`);

                const userId = await authorizeUser(login, pass);
                if (!userId || !latitude || !longitude) return sendError(response, 403);

                const now = new Date();
                await query("UPDATE user_list SET latitude = ?, longitude = ?, last_ping = ?, quests = ? WHERE user = ?", [latitude, longitude, now, quests, userId]);

                const usersLoc = await query(`
                    SELECT * FROM user_list 
                    JOIN room ON user_list.room = room.idroom 
                    JOIN user ON user_list.user = user.iduser 
                    WHERE room.name = ?`        , [roomName]);

                if (usersLoc.length === 0) return sendError(response, 500);

                const users = usersLoc.map(u => u.login);
                const latitudes = usersLoc.map(u => u.latitude);
                const longitudes = usersLoc.map(u => u.longitude);
                const questsReturn = usersLoc.map(u => u.quests)

                response.setHeader("users", JSON.stringify(users));
                response.setHeader("latitude", JSON.stringify(latitudes));
                response.setHeader("longitude", JSON.stringify(longitudes));
                response.setHeader("quests", JSON.stringify(questsReturn));
                console.log(quests);
                return response.end();
            }

            case "/kick_user": {
                const { login, pass, kickTarget } = dataJson;

                const results = await query(`
                    SELECT iduser FROM user 
                    JOIN user_list ON user.iduser = user_list.user 
                    WHERE login = ? AND password = ? AND is_admin = 1`, [login, pass]);

                if (results.length === 0) return sendError(response, 403);

                await query(`
                    DELETE ul FROM user_list ul 
                    JOIN user u ON ul.user = u.iduser   
                    WHERE u.login = ?`, [kickTarget]);

                return response.end();
            }

            case "/qr_check": {
                const { login, pass, roomName, questName } = dataJson;
                const userId = await authorizeUser(login, pass);
                if (!userId) return sendError(response, 403);

                const roomResults = await query("SELECT * FROM room WHERE name = ? AND password = ?", [roomName, roomPassword]);
                if (roomResults.length === 0) return sendError(response, 404);

                await query('Insert into quests(user, room, quest) VALUES (?, ?, ?)', [userId, roomResults[0].idroom, questName]);

                return response.end();
            }

            case "/check_quests": {
                const { login, pass, roomName } = dataJson;

                const results = await query(`
                    SELECT * FROM user 
                    JOIN user_list ON user.iduser = user_list.user 
                    WHERE login = ? AND password = ? AND is_admin = 1`, [login, pass]);

                if (results.length === 0) return sendError(response, 403);

                const questResults = await query(`
                    select * from quests where room =?`, [results[0].room]);

                const users = questResults.map(u => u.user);
                const quests = questResults.map(u => u.quest);

                response.setHeader("users", JSON.stringify(users));
                response.setHeader("quests", JSON.stringify(quests));


                return response.end();
            }

            default:
                response.statusCode = 404;
                return response.end("Not Found");
        }
    } catch (err) {
        console.error("Unhandled error:", err);
        sendError(response, 500, "Server Error");
    }

}).listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
