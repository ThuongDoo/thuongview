// Dữ liệu giả lập để xem thử giao diện khi chưa kết nối Facebook
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NAMES = [
  ['Góc Ẩm Thực Việt', 'Ẩm thực'], ['Mẹo Vặt Mỗi Ngày', 'Giáo dục'], ['Phượt Cùng Tôi', 'Du lịch'], ['Cười Xuyên Màn Hình', 'Giải trí'],
  ['Bếp Nhà Mây', 'Ẩm thực'], ['Review Đồ Ăn Sài Gòn', 'Ẩm thực'], ['Hà Nội Phố', 'Du lịch'], ['Thú Cưng Đáng Yêu', 'Thú cưng'],
  ['Học Tiếng Anh 5 Phút', 'Giáo dục'], ['Đồ Gia Dụng Thông Minh', 'Mua sắm'], ['Clip Hài Tổng Hợp', 'Giải trí'], ['Đà Lạt Mộng Mơ', 'Du lịch'],
  ['Món Ngon Miền Tây', 'Ẩm thực'], ['Gym Tại Nhà', 'Thể thao'], ['Làm Đẹp Mỗi Ngày', 'Làm đẹp'], ['Xe & Đời', 'Ô tô'],
  ['Nhạc Chill Cuối Tuần', 'Âm nhạc'], ['Mẹ Bỉm Sữa', 'Gia đình'], ['Công Nghệ 24h', 'Công nghệ'], ['Trồng Cây Ban Công', 'Nhà vườn'],
  ['Biển Nha Trang', 'Du lịch'], ['Ăn Vặt Cổng Trường', 'Ẩm thực'], ['Tâm Sự Cuộc Sống', 'Cộng đồng'], ['Shop Thời Trang Nữ', 'Mua sắm'],
  ['Bóng Đá Phủi', 'Thể thao'],
];
const PAGES = NAMES.map(([name, category], i) => ({
  id: `demo_${i + 1}`,
  name,
  category,
  followers: Math.round(8000 + ((i * 7919) % 300000)),
  business: i < 18 ? 'ThuongDo' : null,
}));

const CAPTIONS = [
  'Cách làm bánh xèo giòn rụm tại nhà 🥞', 'Mẹo gấp quần áo siêu nhanh', 'Hoàng hôn trên đèo Mã Pì Lèng',
  'Khi mẹ bảo "con xem lại đi" 😂', 'Bún bò Huế chuẩn vị', '3 mẹo tiết kiệm điện mùa hè', 'Một ngày ở Hội An',
  'Pha cà phê muối kiểu mới', 'Thử thách 24h chỉ ăn đồ 10k', 'Review quán ốc vỉa hè', 'Săn mây Tà Xùa lúc 5h sáng',
  'Làm sạch nồi cháy chỉ với 1 nguyên liệu', 'Đi chợ nổi Cái Răng', 'Khi bạn thân đi du lịch cùng', 'Gỏi cuốn tôm thịt',
  'Cách bảo quản rau tươi cả tuần', 'Cắm trại bên hồ Trị An', 'Phản ứng của mèo khi thấy dưa leo',
];

export function demoData() {
  const now = Date.now();
  const d = new Date(now);
  const anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6).getTime(); // ổn định trong ngày
  const reels = [];
  PAGES.forEach((p, pi) => {
    const rand = rng(pi * 977 + 13);
    const count = 6 + Math.floor(rand() * 16);
    for (let i = 0; i < count; i++) {
      const ageDays = rand() * 45;
      const created = Math.min(now - 600000, anchor - ageDays * 86400000 + 6 * 3600000 - pi * 3600000);
      const viral = rand();
      const base = viral > 0.9 ? 40000 + rand() * 900000 : viral > 0.7 ? 6000 + rand() * 30000 : 200 + rand() * 6000;
      // view tăng dần theo thời gian để thấy được mức tăng khi bấm Làm mới
      const ageFactor = Math.min(1, (now - created) / (3 * 86400000));
      const views = Math.round(base * (0.35 + 0.65 * ageFactor));
      reels.push({
        id: `${p.id}_reel_${i}`,
        pageId: p.id,
        description: CAPTIONS[Math.floor(rand() * CAPTIONS.length)],
        createdTime: new Date(created).toISOString(),
        permalink: 'https://www.facebook.com/reel/',
        picture: null,
        length: Math.round(8 + rand() * 80),
        views,
        viewsAvailable: true,
        reach: Math.round(views * (0.6 + rand() * 0.3)),
        likes: Math.round(views * (0.02 + rand() * 0.06)),
        comments: Math.round(views * (0.002 + rand() * 0.01)),
      });
    }
  });
  return {
    businesses: ['ThuongDo'],
    pages: PAGES.map((p) => ({ ...p, link: 'https://facebook.com', picture: null, fanCount: p.followers, error: null })),
    reels,
    warnings: [],
  };
}
