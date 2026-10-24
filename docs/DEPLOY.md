# Deploy bot Long Linh sang laptop

Bản build ngày 11/10/2026, gồm cả phần log chuẩn hoá. Selftest đã đạt.

## 1. File cần gửi

Tất cả nằm trong `D:\claude\LongLinh\dist\`:

| File | Gửi? | Ghi chú |
|---|---|---|
| `LongLinh-Setup.exe` (50 MB) | **Có** | Bộ cài. Bên trong có `.env` và key Google đã mã hoá bằng mật khẩu. |
| `INSTALLER-PASSWORD.txt` | **Chỉ gửi mật khẩu, qua kênh khác** | Gọi điện hoặc đọc trực tiếp. Không gửi chung kênh với file, không gửi qua chat, Facebook hay email. |
| `LongLinh.exe` | Không | File chạy, đã nằm sẵn trong bộ cài. |

Gửi bộ cài bằng USB, hoặc Google Drive / OneDrive **để chế độ riêng tư**, chỉ chia sẻ cho người bên kia, và xoá ngay sau khi họ tải xong.

## 2. Trước khi cài

- **Chỉ được chạy MỘT bot cùng lúc.** Bot trên máy này đang tắt; đừng bật lại khi laptop đã chạy. Hai bot cùng chạy sẽ trả lời trùng và ghi đè dữ liệu của nhau.
- **Không cài vào tối thứ 7 từ 17:30 đến 21:00.**
- Laptop cần: Windows 10/11 64-bit, có mạng, cắm sạc.

## 3. Bên laptop cài (khoảng 5 phút)

1. Chép `LongLinh-Setup.exe` ra Desktop.
2. **Bấm đúp** để chạy. Bộ cài luôn tự ghi log vào thư mục Temp, không cần dùng Command Prompt (xem mục 5).
3. Nhập mật khẩu cài đặt.
   - Windows báo "Windows protected your PC": bấm **More info → Run anyway**.
   - Hỏi quyền quản trị (UAC): bấm **Yes**.
4. Bấm **Next**, **để nguyên ô "Giữ máy không ngủ"**, rồi **Install → Finish**.
5. Chờ 1–2 phút, mở **Start → "Long Linh – Trạng thái"**. Thấy **BOT ĐANG CHẠY TỐT** màu xanh là xong.

Bot tự chạy lại mỗi khi bật máy, kể cả khi chưa đăng nhập Windows.

## 4. Kiểm tra sau khi cài

Trên Discord:
- Bảng điều khiển hiện số liệu và dòng "📊 Sheet: đồng bộ …".
- Bấm thử 👥 Chưa đăng ký, 🎮 Thành viên game và 📊 Google Sheet → 🔄 Đồng bộ ngay.
- Bảng 🎮 Chọn nhân vật của tôi vẫn chạy.

Muốn kiểm tra tiếp các mục chưa test, xem bảng ở `docs/LUONG-BOT.md` mục 6.

## 5. Log: phân tích lỗi khi bot chạy ở laptop

Trên laptop, log nằm ở `C:\ProgramData\LongLinh\logs\`:

| File | Nội dung |
|---|---|
| `longlinh.log` (và `.1.log` … `.9.log`) | Log chữ thường: kết nối, lỗi, cảnh báo |
| `events-YYYY-MM-DD.jsonl` | Log có cấu trúc: từng lần bấm nút, kết quả, thời gian, mã lỗi |
| `Setup Log <ngày> #001.txt` | Log của bộ cài. Mở bằng cách gõ `%TEMP%` vào thanh địa chỉ File Explorer rồi Enter; lấy file mới nhất. |

**Cách gửi log về để tôi phân tích:**
1. Bên laptop nén thư mục `C:\ProgramData\LongLinh\logs`, cùng file `Setup Log …txt` mới nhất trong `%TEMP%` nếu cài lỗi, rồi gửi bạn.
2. Bạn giải nén vào ví dụ `D:\longlinh-logs\` trên máy này, rồi nói "xem log laptop".
3. Tôi chạy:
   ```
   npm run logs:report -- --dir D:\longlinh-logs --since 7d
   ```
   Kết quả gồm: nút nào lỗi và mã lỗi gì, nút nào chậm, lần tự nhắc / tự chốt / tự tạo trận, đồng bộ Sheet, và bảng ✅/❌/⏳ cho 18 mục cần test.

Log không chứa token, DB_URL hay key; chỉ có ID Discord, số đếm và tên game.

## 6. Cập nhật bản mới

1. Trên máy này: sửa code, chạy test, rồi `npm run package` để có `dist\LongLinh-Setup.exe` mới. **Mỗi lần build sẽ có mật khẩu mới.**
2. Gửi bộ cài mới và mật khẩu mới, mỗi thứ một kênh riêng như bước 1.
3. Bên laptop chạy bộ cài mới đè lên bản cũ. Log được giữ lại.

## 7. Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| "Trạng thái" báo vàng "đang kết nối" quá 5 phút | Kiểm tra mạng. Gửi `longlinh.log`; thường là mạng chặn kết nối tới database Postgres (Aiven, cổng trong PG_URL). |
| "Cổng 3000 bị chương trình khác chiếm" | Tắt chương trình đang dùng cổng 3000, hoặc gửi log để tôi đổi cổng. |
| Bộ cài báo lỗi và dừng | Gửi file `Setup Log …txt` mới nhất trong `%TEMP%`. Bot cũ (nếu có) vẫn giữ nguyên. |
| Nút Discord báo "This interaction failed" | Bot đang tắt, hoặc laptop ngủ hay mất mạng. Mở "Long Linh – Trạng thái". |
| Cần khởi động lại bot | Start → **"Long Linh – Khởi động lại"**. |
| Gỡ cài đặt | Settings → Apps → **Long Linh Bot** → Uninstall. Log được giữ lại, trừ khi chọn xoá. |
