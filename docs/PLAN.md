# Kanban Pano

> İş akışınızı görselleştirin, önceliklendirin ve hedeflerinize zamanında ulaşın.

## Features
- Yapılacak, Sürüyor ve Bitti sütunları arasında sezgisel sürükle-bırak ve klavye destekli taşıma
- Öncelik dereceleri (Düşük, Orta, Yüksek, Acil) ve renkli etiket yönetimi
- Yaklaşan ve geciken son tarihler için görsel uyarılar ile tamamlanma sesli bildirimi
- Gelişmiş metin arama, öncelik, etiket ve durum bazlı anlık filtreleme
- Hazır 'Günlük Gündem' şablonu ile tek tıkla iş planı oluşturma
- Günlük ve haftalık tamamlanma oranlarını gösteren verimlilik istatistikleri
- Tüm pano verilerini JSON formatında dışa aktarma ve içe aktarma yedekleme sistemi

## Data model
LocalStorage 'kanban_pano_state' anahtarı altında tutulur. State objesi: 'tasks' (id, title, description, columnId: 'todo'|'in_progress'|'done', priority: 'low'|'medium'|'high'|'urgent', tags: string[], dueDate: ISO string or null, createdAt: ISO string, completedAt: ISO string or null, order: number), 'settings' (soundEnabled: boolean), ve 'tags' (kullanıcı tanımlı etiket listesi) alanlarını barındırır.

## Screens
- Üst Bar: Başlık, Arama Girişi, Hızlı Filtre Butonları, Şablon Yükle, Veri Aktar/İçe Aktar ve İstatistik Butonları
- İstatistik Paneli: Günlük ve haftalık tamamlanan görev sayısı, gecikmiş işler ve üretkenlik skoru özeti
- Kanban Çalışma Alanı: 'Yapılacak', 'Sürüyor' ve 'Bitti' sütunları; her sütunda görev sayacı, yeni kart ekleme butonu ve sıralı görev kartları
- Görev Detay/Düzenleme Modalı: Başlık, açıklama, sütun, öncelik seçimi, etiket yöneticisi ve son tarih takvimi
- Erişilebilirlik ve Bildirim Katmanı: Canlı ekran okuyucu duyuruları (aria-live) ve ses sentezi/Web Audio geri bildirimi

## Core logic (`src/logic.js`)
| Function | Signature | Purpose |
|---|---|---|
| `createTask` | `(tasks, taskData, currentTime) => tasks` | Yeni bir görevi doğrular, benzersiz ID ve oluşturulma tarihi ekleyerek ilgili sütunun en sonuna ekler. |
| `updateTask` | `(tasks, taskId, updates, currentTime) => tasks` | Belirtilen görevin verilerini günceller; durum 'done' yapılırsa completedAt ekler, 'done'dan çıkarılırsa completedAt temizler. |
| `deleteTask` | `(tasks, taskId) => tasks` | Verilen ID'ye sahip görevi görev listesinden güvenle kaldırır. |
| `moveTask` | `(tasks, taskId, targetColumnId, targetIndex, currentTime) => tasks` | Görevi hedef sütuna taşır, sütun içi sıralamayı yeniden indeksler ve tamamlama zaman damgasını yönetir. |
| `filterAndSearchTasks` | `(tasks, query, filterPriority, filterTag, filterOverdue, currentTime) => tasks` | Arama metnine, öncelik düzeyine, seçili etikete ve son tarih gecikme durumuna göre görevleri filtreler. |
| `computeDueStatus` | `(dueDate, isCompleted, currentTime) => status` | Görevin son tarihine göre durumunu 'overdue', 'due_soon' (24 saat içinde), 'on_track' veya 'no_due' olarak hesaplar. |
| `calculateStatistics` | `(tasks, currentTime) => stats` | Bugün ve son 7 günde tamamlanan görev sayılarını, gecikmiş görev oranını ve genel tamamlanma yüzdesini hesaplar. |
| `generateDailyAgendaTemplate` | `(currentTime) => tasks` | Kullanıcı için standart öncelikli ve etiketli hazır günlük çalışma görevleri listesi üretir. |
| `validateAndImportData` | `(jsonString) => { success: boolean, data: object|null, error: string|null }` | Dışarıdan yüklenen JSON dosyasının veri şemasını denetler, geçerli ve güvenli pano verisi döner. |

## Test plan
- [ ] createTask geçerli verilerle yeni bir görev oluşturmalı ve todo sütununun sonuna eklemelidir.
- [ ] createTask boş veya sadece boşluk içeren başlıklarda hata fırlatmalıdır.
- [ ] updateTask görevin sütununu 'done' yaptığında completedAt alanını currentTime olarak ayarlamalıdır.
- [ ] updateTask 'done' sütunundaki görevi 'in_progress' yaptığında completedAt değerini null yapmalıdır.
- [ ] moveTask bir sütun içindeki ve sütunlar arasındaki görev sıralamasını (order) doğru indekslemelidir.
- [ ] computeDueStatus son tarihi geçmiş ve tamamlanmamış görevler için 'overdue' dönmelidir.
- [ ] computeDueStatus 24 saatten az kalmış tamamlanmamış görevler için 'due_soon' dönmelidir.
- [ ] filterAndSearchTasks başlık veya açıklamada eşleşen Türkçe karakter duyarlı aramayı filtrelemelidir.
- [ ] calculateStatistics son 7 günde tamamlanan görev adetlerini ve toplam gecikmiş görevleri doğru hesaplamalıdır.
- [ ] generateDailyAgendaTemplate geçerli formatta en az üç temel gündem görevi üretmelidir.
- [ ] validateAndImportData bozuk JSON veya geçersiz sütun kimlikleri içeren verileri reddetmelidir.
