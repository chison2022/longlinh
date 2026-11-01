# Bảng xếp đội (Discord Activity)

Bảng kéo-thả để quản lý xếp đội hình bang chiến: Nhóm 1 / Nhóm 2, mỗi Nhóm 5 PT, mỗi PT 6 người. Người thường chỉ xem (thấy mình ở đâu). Khi quản lý bấm **📢 Công bố đội hình**, bot trên laptop đăng bảng ảnh vào kênh bang chiến (không tag ai); mỗi người tự bấm **👤 Xem PT của tôi** để xem riêng.

Bảng chạy trên một máy chủ web miễn phí (Render) nối chung database Aiven với bot. Bot vẫn chạy trên laptop; khoá Google chỉ nằm ở laptop.

## 1. Discord Developer Portal (app Tiểu Dao)

1. Vào https://discord.com/developers/applications, chọn app **Tiểu Dao**.
2. **OAuth2** -> bấm **Reset Secret** / **Copy** ở *Client Secret* -> giữ lại (sẽ dán vào Render). Không gửi cho ai.
3. **Activities** -> **Settings** -> bật *Enable Activities*.
4. **Activities** -> **URL Mappings**: dòng `/` -> địa chỉ Render của bạn **không có** `https://` (ví dụ `longlinh-activity.onrender.com`).
5. **Installation** -> *Installation Contexts*: tick **Guild Install**.
6. Lưu lại. Mã `CLIENT_ID` là *Application ID* ở trang **General Information**.

## 2. Render (miễn phí)

1. https://render.com -> **New** -> **Web Service** -> nối kho GitHub của dự án.
2. Cấu hình:
   - **Build Command**: `npm ci && npm run activity:build`
   - **Start Command**: `node activity/server.js`
   - **Instance type**: Free
3. **Environment** (chỉ ghi tên biến, giá trị lấy từ file `.env` của bot / Developer Portal):
   - `PG_URL` - chuỗi kết nối Aiven (giống bot)
   - `PG_CA_PEM` - nội dung chứng chỉ CA của Aiven (dán cả đoạn `-----BEGIN CERTIFICATE-----` ... `-----END CERTIFICATE-----`; xuống dòng được thay bằng `\n` cũng được). Trên Render không có file nên dùng biến này thay cho `PG_CA`
   - `CLIENT_ID` - Application ID
   - `CLIENT_SECRET` - Client Secret ở bước 1
   - `DISCORD_TOKEN` - token bot (chỉ để đọc vai trò của máy chủ, xác định ai là quản lý)
4. Bấm **Create Web Service**. Khi build xong, địa chỉ có dạng `xxx.onrender.com`: dán vào URL Mappings (bước 1.4).

Lưu ý: gói miễn phí tự **ngủ** khi lâu không ai dùng; lần mở đầu tiên phải chờ khoảng 50 giây.

### Thứ tự cập nhật

**Luôn cập nhật và chạy bot trước, rồi mới chạy Activity.** Chỉ bot được sửa cấu trúc database (thêm bảng / cột). Nếu Activity khởi động mà database chưa đủ, nó dừng lại và báo "Cập nhật bot trước rồi mới chạy Activity".

### (Tuỳ chọn) Tài khoản Postgres hạn chế cho Activity

Để Render không giữ quyền đầy đủ trên database, tạo một tài khoản riêng chỉ đủ quyền Activity cần (chạy một lần bằng tài khoản chủ trên Aiven, đổi `mat_khau_dai`):

```sql
create role activity login password 'mat_khau_dai';
grant usage on schema public to activity;
grant select on war_events, registrations, discord_members, guilds to activity;
grant select, insert, update on war_lineups to activity;
```

Sau đó đặt `PG_URL` của Render dùng tài khoản `activity` này (bot vẫn dùng tài khoản cũ). Các biến môi trường của Activity: `PG_URL`, `PG_CA_PEM`, `CLIENT_ID`, `CLIENT_SECRET`, `DISCORD_TOKEN`, `PORT` (Render tự đặt).

## 3. Mở trong Discord

Vào một **kênh thoại** của máy chủ -> bấm biểu tượng **Hoạt động** (tên lửa) -> chọn **Tiểu Dao**.

- Quản lý (vai trò quản trị trong cài đặt bot, hoặc có quyền Quản lý máy chủ) kéo-thả được. Trên điện thoại: giữ một chút rồi kéo, hoặc **chạm người rồi chạm ô** muốn xếp.
- Kéo người vào ô đã có người thì hai người đổi chỗ; kéo về khung **Chưa xếp** để bỏ khỏi PT.
- Bảng tự lưu sau khoảng 1 giây; ai sửa cũng được thấy ngay (thông báo "Đã cập nhật bởi người khác").
- Bấm **📢 Công bố đội hình**: bot (laptop phải đang chạy) đăng ảnh trong vòng ~20 giây, đóng đăng ký và ghi tab `LongLinh_DoiHinh` vào Google Sheet (nếu có). Lỗi nếu có sẽ hiện cạnh nút.

## Chạy thử trên máy

`npm run activity:build` rồi `npm run activity` (cần `.env` đủ các biến trên). Trang chỉ chạy được bên trong Discord (cần Embedded App SDK), mở thẳng bằng trình duyệt sẽ chỉ báo "hãy mở từ trong Discord".
