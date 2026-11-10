# Long Linh — bot Discord quản lý bang hội Nghịch Thủy Hàn

Long Linh là bot Discord cho các bang hội trong game **Nghịch Thủy Hàn**. Thành viên và quản lý thao tác gần như hoàn toàn bằng **nút bấm, menu và form** ngay trong Discord. Lệnh gõ tay chỉ có một: `/setup`, dùng lúc cài đặt.

Bot lo phần việc lặp lại hằng tuần của ban quản lý: mở đăng ký bang chiến, nhắc người chưa báo danh, đối chiếu danh sách trong game với Discord, báo ai đã rời bang, ghi mọi thứ ra Google Sheet. Bot cũng có sự kiện bang, hòm thư góp ý ẩn danh và cổng duyệt người mới.

> Bot viết cho một bang cụ thể, nên giao diện và lời nhắn đều bằng tiếng Việt, luật bang chiến theo game Nghịch Thủy Hàn (thứ Bảy 20:00–21:00, nhóm 5 PT × 6 người, môn phái lấy theo role). Phần lớn các thông số này chỉnh được trong bot.

---

## Mục lục

- [Tính năng](#tính-năng)
- [Luồng sử dụng](#luồng-sử-dụng)
- [Công nghệ](#công-nghệ)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Cài đặt để chạy](#cài-đặt-để-chạy)
- [Biến môi trường](#biến-môi-trường)
- [Các lệnh npm](#các-lệnh-npm)
- [Dữ liệu](#dữ-liệu)
- [Google Sheet](#google-sheet)
- [Đóng gói thành bộ cài Windows](#đóng-gói-thành-bộ-cài-windows)
- [Kiểm thử](#kiểm-thử)
- [Bảo mật](#bảo-mật)
- [Giấy phép](#giấy-phép)

---

## Tính năng

### Luôn có

| Tính năng | Mô tả |
|---|---|
| **Bang chiến hằng tuần** | Tự tạo trận theo lịch (hoặc quản lý bấm ⚔️ Tạo bang chiến). Thẻ đăng ký có ✅ Tham gia / ❌ Vắng, đếm theo môn phái, thanh tiến độ quân số, giờ chốt tự đếm ngược. Tự nhắc trước hạn và tự chốt đúng giờ. |
| **Môn phái và vai trò** | Môn phái lấy từ role Discord (không cần chọn lại mỗi tuần). Thành viên tự chọn vai trò mong muốn: Def, Công, Đẩy trụ, Vật tư hoặc "tùy lead". |
| **Chưa đăng ký** | Danh sách người có role thành viên mà chưa báo danh, chia theo phái, kèm nút nhắc (một tin nhắn gom nhiều người, không tag cả server). |
| **Công bố đội hình** | Quản lý dán link Google Sheet đội hình đã chia, bot đăng thông báo cho cả bang. |
| **Danh sách thành viên trong game** | Quản lý tải file `.xlsx` danh sách bang (dựng từ video quay màn hình bằng `scripts/roster-video.js`). Bot vẽ bảng ảnh, so với lần trước (ai mới vào, ai rời, ai đổi chức vụ, ai **có thể** đã đổi tên) và đối chiếu với tên Discord. |
| **Liên kết tên game ↔ Discord** | Mỗi nhân vật gắn với đúng một tài khoản Discord: tự khớp theo tên, thành viên tự chọn, hoặc quản lý ghép tay. So khớp không phân biệt hoa thường, dấu, khoảng trắng và chữ giả mạo (ký tự Cyrillic hay chữ kiểu toán học trông giống chữ Latin). |
| **✏️ Đổi tên (có xác nhận)** | Khi nhân vật đổi tên trong game, bot gợi ý cặp tên cũ → tên mới (cùng phái, số ngày trong bang khớp). Quản lý bấm xác nhận thì nhân vật giữ nguyên liên kết, lịch sử và tên cũ. Bot không bao giờ tự đổi. |
| **Trạng thái thành viên** | Đang ở bang / Mới vào / Quay lại (kèm ngày quay lại) / Đã rời. |
| **Quân số** | Bảng điều khiển hiện số thành viên chính thức / học việc và báo khi dưới mục tiêu. |
| **Google Sheet** | Bot ghi bảng thành viên, bang chiến tuần này, lịch sử bang chiến trong tháng và sự kiện (xem [Google Sheet](#google-sheet)). |

### Bật / tắt theo bang (🧩 Tính năng)

| Tính năng | Mô tả |
|---|---|
| 🛡 **Tuyến Khiên** | Thành viên khai báo nhóm Nhất Tuyến Khiên (ai đi cùng ai) để lead xếp chung PT. |
| 🎉 **Sự kiện** | Sự kiện ngoài bang chiến: tạo bằng form, xem trước rồi mới đăng, giới hạn số người (tối thiểu / tối đa), ✅ / ❓ / ❌, tự nhắc, tự chốt, xuất file Word danh sách. |
| 📮 **Hòm thư** | Thành viên gửi góp ý, khiếu nại, báo lỗi; có thể **ẩn danh**. Thư ẩn danh được mã hoá: quản lý không thấy người gửi; chỉ chủ bot giữ khoá riêng (không bao giờ nằm trên máy chạy bot) mới tra được khi thư vi phạm nghiêm trọng. Người gửi xem trả lời bằng mã thư. |
| 🚪 **Cổng vào** | Người mới vào server chọn nhân vật trong danh sách game: có tên thì bot tự duyệt và cấp role thành viên + role phái (quản lý nhận thẻ có nút ↩️ Thu hồi), tên tự gõ thì chờ quản lý duyệt. |
| 🎧 **Treo voice** | Bot ngồi sẵn trong một kênh voice cố định (tắt mic, tắt loa) và tự vào lại khi bị ngắt. |
| ⏰ **Báo off lâu** | Sau mỗi lần cập nhật danh sách game, báo quản lý ai đã off quá N ngày. |
| 👋 **Báo rời game** | Báo quản lý ai đã rời bang trong game nhưng còn trong Discord, ai trong số đó **vẫn đang báo danh** bang chiến (kèm nút 🗑️ Gỡ báo danh) và nút gỡ liên kết tên. Bot không bao giờ tự kick. |

### Công cụ cho chủ bot (chạy trên máy)

- `scripts/roster-video.js`: cắt khung hình từ video quay danh sách bang trong game, dựng file `.xlsx` và so với lần trước.
- `scripts/import-game-roster.js`, `scripts/import-attendance.js`: nhập danh sách bang / kết quả chuyên cần (màn hình kết quả sau trận) vào database, có chế độ `--dry` chỉ đọc.
- `scripts/log-report.js`: tóm tắt log sự kiện của bot.
- `scripts/mailbox-keygen.js`, `scripts/mailbox-who.js`: tạo cặp khoá hòm thư ẩn danh, tra người gửi một thư.

---

## Luồng sử dụng

1. Quản lý chạy **`/setup`**: chọn kênh thông báo, kênh admin, role quản lý, role thành viên, bật các tính năng cần dùng, rồi bấm **📌 Đăng tất cả**.
2. Bot đăng **🏯 Bảng điều khiển** ở kênh admin. Mọi việc quản lý đi từ đây: tạo / chốt bang chiến, công bố đội hình, xem người chưa đăng ký, danh sách game, Google Sheet, cài đặt.
3. Thành viên bấm nút trên **thẻ bang chiến** ở kênh thông báo. Bấm lần đầu thì chọn phái (hoặc lấy từ role), các lần sau chỉ một cú bấm.
4. Mỗi lần có thay đổi, bot tự cập nhật thẻ bang chiến, bảng điều khiển và Google Sheet.

---

## Công nghệ

- **Node.js 24**, **discord.js 14** (Components V2: container, select menu, modal có upload file).
- **PostgreSQL** qua `pg` (đang dùng gói miễn phí của Aiven). Lớp truy cập dữ liệu riêng (`src/db.js`) với giao dịch lồng nhau qua `AsyncLocalStorage`.
- **Express** chỉ để mở `GET /health` trên `127.0.0.1` (công cụ theo dõi đọc).
- **node-cron**: các việc định kỳ (mở đăng ký, nhắc, chốt, thông báo sau khi nhập danh sách).
- **@napi-rs/canvas**: vẽ ảnh bảng thành viên và ảnh đội hình.
- **ExcelJS**: đọc / xuất file danh sách `.xlsx`.
- **Google Sheets / Docs API** gọi trực tiếp bằng JWT của service account (không dùng thư viện googleapis).
- Kiểm thử: `node:test` + **PGlite** (PostgreSQL chạy trong bộ nhớ, không cần cài database).
- Đóng gói: **@yao-pkg/pkg** (ra file `.exe`) + **Inno Setup 6** (bộ cài có mã hoá).

---

## Cấu trúc thư mục

```
app.js                    Điểm khởi động: log, cổng /health, kết nối DB (thử lại khi mất mạng), đăng nhập bot
config/
  defaults.js             Giá trị mặc định: môn phái, lịch, số PT, vai trò, loại sự kiện…
  pg.js                   Tạo pool PostgreSQL từ PG_URL + chứng chỉ CA
  mailbox-public.pem      Khoá CÔNG KHAI của hòm thư ẩn danh (khoá riêng không bao giờ ở đây)
db/schema.sql             Cấu trúc database (tạo tự động khi database trống)
src/
  db.js                   q / one / tx, tạo bảng, các bước nâng cấp cấu trúc khi khởi động
  bot/                    Client Discord, làm mới thẻ, thông báo, treo voice, đồng bộ Sheet
    commands/             Lệnh /setup
    interactions/         Xử lý nút / menu / form (định tuyến theo tiền tố customId)
    ui/                   Dựng tin nhắn, ảnh, form (thuần, không gọi Discord / DB)
  services/               Logic nghiệp vụ và truy vấn SQL (bang chiến, đăng ký, danh sách game, sự kiện, cổng vào, hòm thư…)
    sheets/               Google Sheets: dựng các tab, ghi tab có giữ ô người khác sửa
  jobs/scheduler.js       Việc định kỳ
  utils/time.js           Giờ Việt Nam (UTC+7), định dạng ngày giờ
scripts/                  Công cụ dòng lệnh cho chủ bot
packaging/                Đóng gói bộ cài Windows (pkg + Inno Setup), script trạng thái / khởi động lại
test/                     Kiểm thử tự động
docs/DEPLOY.md            Hướng dẫn cài lên một máy Windows khác
```

---

## Cài đặt để chạy

### 1. Chuẩn bị

- Node.js **24** trở lên.
- Một **PostgreSQL** (Aiven miễn phí là đủ: tạo service, tải chứng chỉ CA về `certs/`, lấy Service URI).
- Một **ứng dụng Discord** tại <https://discord.com/developers/applications>:
  - Tab **Bot**: lấy token, bật **Server Members Intent**.
  - Mời bot vào server với quyền: Xem kênh, Gửi tin nhắn, Nhúng liên kết, Đính kèm file, Đọc lịch sử, Quản lý vai trò (nếu dùng 🚪 Cổng vào), Kết nối (nếu dùng 🎧 Treo voice). Role của bot phải **cao hơn** các role nó cần cấp.

### 2. Cài và cấu hình

```bash
git clone <repo>
cd <repo>
npm install
cp .env.example .env      # rồi điền các giá trị (xem bảng bên dưới)
```

### 3. Đăng ký lệnh `/setup` và chạy

```bash
npm run deploy            # đăng ký slash command (DEV_GUILD_ID có giá trị thì chỉ đăng ở server đó, cập nhật ngay)
npm start                 # hoặc: npm run dev (tự chạy lại khi sửa code)
```

Lần đầu kết nối vào database trống, bot tự tạo các bảng theo `db/schema.sql`. Sau đó vào Discord gõ `/setup`.

> **Chỉ chạy một bot cho mỗi token.** Hai tiến trình cùng token sẽ trả lời trùng và ghi đè dữ liệu của nhau. Bot cũng tự thoát nếu cổng `PORT` đã có tiến trình khác giữ.

### 4. (Tuỳ chọn) Google Sheet

Tạo một **service account** trên Google Cloud, bật Google Sheets API (và Google Docs API nếu dùng xuất sự kiện ra Docs), tải file khoá JSON về `google-key.json` ở thư mục gốc. Trong Discord: **📊 Google Sheet → ✏️ Đặt Sheet**, dán link một Google Sheet đã chia sẻ quyền **Editor** cho email của service account.

### 5. (Tuỳ chọn) Hòm thư ẩn danh

```bash
npm run mail:keygen       # tạo cặp khoá; chỉ khoá công khai vào config/, khoá riêng giữ ở nơi an toàn, KHÔNG để trên máy chạy bot
```

---

## Biến môi trường

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Token của bot |
| `CLIENT_ID` | ✅ | Application ID (để đăng ký slash command) |
| `PG_URL` | ✅ | Chuỗi kết nối PostgreSQL, ví dụ `postgres://user:pass@host:port/defaultdb?sslmode=require` |
| `PG_CA` | Aiven: ✅ | Đường dẫn chứng chỉ CA (tương đối so với thư mục chứa `.env`), ví dụ `certs/aiven-ca.pem` |
| `PORT` | | Cổng của `/health` (mặc định `3000`, chỉ nghe trên `127.0.0.1`) |
| `DEV_GUILD_ID` | | Đăng ký slash command cho một server thử nghiệm |
| `GOOGLE_KEY_FILE` | | Đường dẫn khoá service account (mặc định `google-key.json` ở thư mục gốc) |
| `ROSTER_VIDEO_DIR` | | Thư mục chứa video quay danh sách bang (cho `scripts/roster-video.js latest`) |

---

## Các lệnh npm

| Lệnh | Việc |
|---|---|
| `npm start` | Chạy bot |
| `npm run dev` | Chạy bot, tự khởi động lại khi sửa code |
| `npm run deploy` | Đăng ký slash command |
| `npm test` | Chạy toàn bộ kiểm thử |
| `npm run roster:video -- latest \| frames \| build …` | Xử lý video danh sách bang → `.xlsx` |
| `npm run roster:import -- --guild <id> --file <xlsx> [--dry]` | Nhập danh sách bang vào database |
| `npm run attendance:import -- --guild <id> --file <txt> --date <YYYY-MM-DD> [--dry]` | Nhập chuyên cần một trận |
| `npm run logs:report` | Tóm tắt log sự kiện |
| `npm run mail:keygen` / `npm run mail:who` | Khoá hòm thư ẩn danh / tra người gửi |
| `npm run package` | Đóng gói bộ cài Windows |

---

## Dữ liệu

Toàn bộ dữ liệu nằm trong PostgreSQL (xem `db/schema.sql`). Các bảng chính:

| Bảng | Nội dung |
|---|---|
| `guilds` | Cấu hình từng server (kênh, role, tính năng, lịch…) dạng `jsonb` |
| `discord_members` | Thành viên Discord đã tương tác: môn phái, vai trò mong muốn, Tuyến Khiên |
| `roster_imports` | Nhật ký mỗi lần nhập danh sách game |
| `game_characters` | Nhân vật trong game: giữ một dòng qua mọi lần nhập; có ngày rời, ngày quay lại, tên cũ |
| `character_links` | Liên kết nhân vật ↔ tài khoản Discord (1–1) |
| `war_events`, `registrations` | Bang chiến và báo danh |
| `attendance_entries` | Chuyên cần thật (từ màn hình kết quả) |
| `guild_events`, `event_replies` | Sự kiện và trả lời |
| `gate_requests` | Yêu cầu vào bang qua cổng |
| `mail_letters` | Thư hòm thư (thư ẩn danh chỉ lưu bản mã hoá của người gửi) |

ID của bang chiến, sự kiện, yêu cầu vào bang và thư dùng chuỗi 24 ký tự hex, vì chúng nằm trong customId của nút trên tin nhắn cũ. Khi bot khởi động, các bước nâng cấp cấu trúc (thêm / bỏ cột) tự chạy, an toàn khi chạy lại nhiều lần.

---

## Google Sheet

Bot ghi 4 tab, mỗi tab là một Bảng (Table) có bộ lọc trên mọi cột:

| Tab | Nội dung |
|---|---|
| `ThanhVien` | Mỗi nhân vật đang ở bang một dòng (tên game, phái, chức vụ, số ngày, online lần cuối, trạng thái, tên Discord, liên kết, vai trò, Tuyến Khiên, ghi chú, tên cũ, ngày quay lại), cộng các thành viên chỉ có trên Discord |
| `BangChien_TuanNay` | Trạng thái báo danh trận tuần này (✅ Đi / ❌ Vắng / ⏳ Chưa báo) |
| `BangChien_LichSu` | Các trận đã đánh trong tháng: ✅ Đi / ⏳ Không đi / ❌ Vắng / ⚠️ Đăng ký nhưng không tham gia / 🆕 Chưa vào bang |
| `BaoDanh` | Bảng báo danh 12 trận gần nhất: mỗi nhân vật một dòng, mỗi trận một cột (ngày/tháng) — `V` đi, `X` vắng hoặc đăng ký mà không tham gia, trống = không báo |
| `SuKien` | Ai trả lời sự kiện nào |

- Các cột tra cứu ở tab bang chiến / sự kiện là công thức `VLOOKUP` sang `ThanhVien` (tự dùng `,` hay `;` theo ngôn ngữ của Sheet).
- **Ô người khác sửa tay không bị ghi đè.** Mỗi tab có một tab ẩn `_LL_<tên tab>` lưu đúng giá trị bot ghi lần trước; ô nào khác bản đó là người sửa nên được giữ, xoá trắng ô thì bot ghi lại. Cột `Ghi chú` bot không bao giờ ghi. Cột và dòng người khác tự thêm cũng được giữ.
- Người đã rời bang và người mang role "Kẻ lạ mặt" không được ghi.
- Chỉ những công thức do chính bot tạo mới được ghi dưới dạng công thức; mọi tên người dùng luôn ghi dạng chữ (chặn chèn công thức qua tên Discord).

---

## Đóng gói thành bộ cài Windows

```bash
npm run package                       # dùng .env ở thư mục gốc
npm run package -- --env <file.env>   # dùng một file .env khác
```

Kết quả nằm trong `dist/`:

- `LongLinh.exe`: bot đóng gói một file (Node 24).
- `LongLinh-Setup.exe`: bộ cài Inno Setup **có mã hoá**. Mật khẩu ngẫu nhiên ghi vào `dist/INSTALLER-PASSWORD.txt` và đổi sau mỗi lần build.

Bộ cài chép bot cùng `.env`, chứng chỉ CA và khoá Google (nếu có), khoá quyền truy cập thư mục, tạo Scheduled Task chạy bot khi bật máy (kể cả chưa đăng nhập) và tự khởi động lại khi lỗi. Nó cũng thêm lối tắt "Long Linh – Trạng thái". Chi tiết ở `docs/DEPLOY.md`.

> Gửi file `LongLinh-Setup.exe` và mật khẩu qua **hai kênh khác nhau**, vì bộ cài chứa `.env` (token, mật khẩu database).

---

## Kiểm thử

```bash
npm test
```

Khoảng 1.400 kiểm thử chạy trong vài chục giây, không cần mạng hay database thật:

- Logic nghiệp vụ và SQL chạy trên **PGlite** (PostgreSQL trong bộ nhớ).
- Discord và Google Sheets được thay bằng bản giả (`test/fakeSheets.js`, các stub trong từng file test).
- Dữ liệu trong test (ID, tên người, tên server) đều là giả.

---

## Bảo mật

Những file sau **không bao giờ** được commit (đã có trong `.gitignore`):

- `.env`: token Discord, chuỗi kết nối database.
- `google-key.json`: khoá service account Google.
- `*private*.pem`: khoá riêng của hòm thư ẩn danh.
- `dist/`: bộ cài (chứa `.env`) và mật khẩu bộ cài.
- `logs/`: log khi chạy.

Một số điểm trong thiết kế:

- `/health` chỉ nghe trên `127.0.0.1`.
- Log tự che token, mật khẩu trong chuỗi kết nối và khoá riêng.
- Bộ cài từ chối đóng gói nếu phát hiện khoá riêng hòm thư hoặc mật khẩu khoá trong `.env`.
- Mọi nút quản lý (`adm:*`) đều kiểm tra quyền trước khi làm gì.
- Báo danh chỉ được ghi khi trận còn mở (kiểm tra lại trong cùng giao dịch có khoá dòng).

Phát hiện vấn đề bảo mật? Vui lòng báo riêng cho chủ repo thay vì mở issue công khai.

---

## Giấy phép

[MIT](LICENSE): dùng, sửa, chia sẻ thoải mái, miễn giữ lại thông báo bản quyền.

Font **Be Vietnam Pro** trong `assets/fonts/` theo giấy phép SIL Open Font License 1.1 (`assets/fonts/OFL.txt`).
