# Bảng xếp đội (Discord Activity)

Bảng kéo-thả để quản lý xếp đội hình bang chiến: Nhóm 1 / Nhóm 2, mỗi Nhóm 5 PT, mỗi PT 6 người. Người thường chỉ xem (thấy mình ở đâu). Khi quản lý bấm **📢 Công bố đội hình**, bot trên laptop đăng bảng ảnh vào kênh bang chiến (không tag ai); mỗi người tự bấm **👤 Xem PT của tôi** để xem riêng.

## Kiến trúc (đọc cái này trước)

```
laptop (bot)  ──chốt đăng ký──►  Neon (database RIÊNG của bảng)  ◄──  Render (Activity)
     │                                                                  chỉ có DATABASE_URL, CLIENT_ID, CLIENT_SECRET
     └── database chính (Aiven): Activity KHÔNG BAO GIỜ chạm vào; Render không giữ token bot
```

- Bot **chép một lần** vào Neon khi đăng ký được **chốt** (bấm 🔒 Chốt, hoặc tới giờ tự chốt, hoặc lúc bot khởi động mà bang chiến đã chốt từ trước): thông tin máy chủ (vai trò quản lý, các phái + icon, cỡ đội hình), bang chiến và danh sách người báo danh (tên trong game, phái, nguyện vọng, nhóm Tuyến Khiên). Sau đó **không đồng bộ liên tục**.
- Chốt lại lần nữa (mở lại rồi chốt) thì cập nhật danh sách người báo danh nhưng **giữ nguyên** những gì quản lý đã làm trên bảng: chỗ đứng, nhiệm vụ, ghi chú, người thêm tay, người đã bị bỏ. Ai huỷ báo danh thì rời bảng; ai báo danh lại thì quay về.
- Quản lý (kéo-thả được) = chủ máy chủ, hoặc có vai trò quản trị đã cài cho bot, hoặc vai trò có quyền Administrator / Manage Server (bot đọc lúc chép).
- Bảng đọc/ghi **chỉ** Neon. Bot hỏi Neon (nhịp ở bảng dưới) xem có yêu cầu công bố không, rồi đăng ảnh, đóng đăng ký ở database chính và ghi Google Sheet. Nếu Neon tạm hỏng: bot ghi log, thử lại sau, không sập; nút “Xem PT của tôi” trả lời “chưa xem được lúc này”.

## 1. Neon (database riêng của bảng)

Đã có sẵn một project Neon. Lấy chuỗi kết nối (**pooled**, có `sslmode=require`).

- **Laptop (file `.env` của bot)**: đặt `ACTIVITY_PG_URL=...` hoặc dùng luôn `DATABASE_URL=...` (bot đọc `ACTIVITY_PG_URL`, nếu không có thì `DATABASE_URL`). Không có cả hai thì bot **tắt** cầu nối này (ghi log một lần), mọi thứ khác vẫn chạy. Bot cũng **từ chối** nếu địa chỉ này trùng máy chủ với `PG_URL` (database chính) để không bao giờ ghi nhầm vào đó.
- Bot tự tạo các bảng `act_*` (file `activity/schema.sql`) mỗi lần khởi động; Activity chỉ kiểm tra chúng có đủ.

### Khi nào Neon “thức” (để nó ngủ được, tiết kiệm giờ chạy miễn phí)

Neon tự ngủ khi 5 phút không ai gọi tới. Bot cố gắng hỏi Neon **ít nhất có thể**:

| Lúc nào | Bot hỏi Neon |
| --- | --- |
| Không có bang chiến nào đã chốt/công bố bắt đầu trong vòng 7 ngày tới | **không hỏi** (chỉ kiểm tra database chính mỗi 5 phút) |
| Có bang chiến đã chốt trong vòng 7 ngày | mỗi 20 giây trong 10 phút đầu, sau đó mỗi 2 phút; có yêu cầu công bố thì quay lại 20 giây |
| Tìm bang chiến đã chốt mà Neon chưa có (khởi động lại, Neon từng hỏng) | chỉ khi có bang chiến *mới* cần chép; chép xong bot nhớ trong bộ nhớ nên không hỏi lại |
| Khi chốt đăng ký / mở lại đăng ký / bang chiến kết thúc | một lần ghi nhỏ |

Người dùng mở bảng trong Discord thì Neon thức (đó là lúc dùng thật). Kết nối thừa được đóng sau 30 giây, mỗi câu lệnh tối đa 10 giây. Hệ quả: bấm “Công bố” có thể phải chờ **tới 2 phút** nếu bot đang ở nhịp chậm (sau 10 phút không ai công bố).

## 2. Discord Developer Portal (app Tiểu Dao)

1. Vào https://discord.com/developers/applications, chọn app **Tiểu Dao**.
2. **OAuth2** -> bấm **Reset Secret** / **Copy** ở *Client Secret* -> giữ lại (sẽ dán vào Render). Không gửi cho ai.
3. **Activities** -> **Settings** -> bật *Enable Activities*.
4. **Activities** -> **URL Mappings**: dòng `/` -> địa chỉ Render của bạn **không có** `https://` (ví dụ `longlinh-activity.onrender.com`).
5. **Installation** -> *Installation Contexts*: tick **Guild Install**.
6. Lưu lại. Mã `CLIENT_ID` là *Application ID* ở trang **General Information**.

## 3. Render (miễn phí)

1. https://render.com -> **New** -> **Web Service** -> nối kho GitHub của dự án.
2. Cấu hình:
   - **Build Command**: `npm ci && npm run activity:build`
   - **Start Command**: `node activity/server.js`
   - **Instance type**: Free
3. **Environment** (chỉ 3 biến, giá trị lấy từ Neon / Developer Portal; `PORT` Render tự đặt):
   - `DATABASE_URL` - chuỗi kết nối Neon (pooled)
   - `CLIENT_ID` - Application ID
   - `CLIENT_SECRET` - Client Secret ở bước 2
4. Bấm **Create Web Service**. Khi build xong, địa chỉ có dạng `xxx.onrender.com`: dán vào URL Mappings (bước 2.4).

Lưu ý: gói miễn phí tự **ngủ** khi lâu không ai dùng; lần mở đầu tiên phải chờ khoảng 50 giây. Render **không** cần `DISCORD_TOKEN`, `PG_URL` hay chứng chỉ Aiven.

### Thứ tự cập nhật

**Luôn cập nhật và chạy bot trước, rồi mới chạy Activity.** Bot tạo bảng trong Neon và chép bang chiến đã chốt. Nếu Activity khởi động khi Neon chưa đủ bảng, nó dừng lại và báo "Cập nhật bot trước rồi mới chạy Activity".

## 4. Mở trong Discord

Vào một **kênh thoại** của máy chủ -> bấm biểu tượng **Hoạt động** (tên lửa) -> chọn **Tiểu Dao**. Bảng chỉ có bang chiến **đã chốt đăng ký**; chưa chốt thì chưa thấy.

- Quản lý kéo-thả được. Trên điện thoại: giữ một chút rồi kéo, hoặc **chạm người rồi chạm ô** muốn xếp.
- Kéo người vào ô đã có người thì hai người đổi chỗ; kéo về khung **Chưa xếp** để bỏ khỏi PT.
- Chạm vào người đã xếp để giao **nhiệm vụ** (mặc định theo nguyện vọng họ chọn khi báo danh) hoặc chọn "Chuyển chỗ"; nút **🎯 Nhiệm vụ** để thêm / sửa / xoá nhiệm vụ riêng của bang; mỗi PT có ô ghi chú ngắn.
- **✨ Gợi ý chia đội**: chia ngẫu nhiên nhưng mỗi PT có ít nhất 1 Tố Vấn và 1 Thiết Y; chọn “chỉ điền ô trống” hoặc “chia lại toàn bộ”.
- **➕ Thêm người**: thêm tay người chưa báo danh (tên, phái, nguyện vọng, nhiệm vụ). Người thêm tay hiện trong ảnh và Google Sheet như mọi người nhưng không có nút “Xem PT của tôi”.
- **✖ Bỏ khỏi danh sách** (trong menu người hoặc ở dòng "Chưa xếp"): người thêm tay bị xoá hẳn; người đã báo danh vào mục **Đã bỏ (N)** để khôi phục, và vẫn bị bỏ khi chốt lại.
- Bảng tự lưu sau khoảng 1 giây; ai sửa cũng được thấy ngay (thông báo "Đã cập nhật bởi người khác").
- Bấm **📢 Công bố đội hình**: bot (laptop phải đang chạy) đăng ảnh trong vòng 20 giây đến 2 phút, đóng đăng ký và ghi tab `LongLinh_DoiHinh` vào Google Sheet (nếu có). Lỗi nếu có sẽ hiện cạnh nút.

## Chạy thử trên máy

`npm run activity:build` rồi `npm run activity` (cần `DATABASE_URL`, `CLIENT_ID`, `CLIENT_SECRET` trong `.env`, và bot đã chạy ít nhất một lần để tạo bảng). Trang chỉ chạy được bên trong Discord (cần Embedded App SDK), mở thẳng bằng trình duyệt sẽ chỉ báo "hãy mở từ trong Discord".
