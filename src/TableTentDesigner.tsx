import React, { useState, useRef, useEffect } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { Printer, Upload, Image as ImageIcon, SlidersHorizontal, Type, LayoutTemplate } from 'lucide-react';
import type { DiningTable as Table, VenueSettings, TableTentConfig } from '../server/types';

interface Props {
  tables: Table[];
  settings: VenueSettings;
  publicUrl: string;
}

function FancyQRCode({ url, logoUrl, qrColor, qrBgColor }: { url: string, logoUrl?: string, qrColor: string, qrBgColor: string }) {
  const ref = useRef<HTMLDivElement>(null);
  
  const [qrCode] = useState(() => new QRCodeStyling({
    width: 240,
    height: 240,
    type: "svg",
    data: url,
    image: logoUrl,
    margin: 10,
    qrOptions: {
      typeNumber: 0,
      mode: "Byte",
      errorCorrectionLevel: "H"
    },
    imageOptions: {
      hideBackgroundDots: true,
      imageSize: 0.4,
      margin: 5,
      crossOrigin: "anonymous",
    },
    dotsOptions: {
      color: qrColor,
      type: "classy-rounded"
    },
    backgroundOptions: {
      color: qrBgColor,
    },
    cornersSquareOptions: {
      color: qrColor,
      type: "extra-rounded"
    },
    cornersDotOptions: {
      color: qrColor,
      type: "dot"
    }
  }));

  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = '';
      qrCode.append(ref.current);
    }
  }, [qrCode, ref]);

  useEffect(() => {
    qrCode.update({
      data: url,
      image: logoUrl,
      dotsOptions: { color: qrColor },
      backgroundOptions: { color: qrBgColor },
      cornersSquareOptions: { color: qrColor },
      cornersDotOptions: { color: qrColor }
    });
  }, [qrCode, url, logoUrl, qrColor, qrBgColor]);

  return <div ref={ref} />;
}

export function TableTentDesigner({ tables, settings, publicUrl }: Props) {
  const [selectedTable, setSelectedTable] = useState<Table | null>(tables[0] || null);
  
  const initialConfig: Partial<TableTentConfig> = settings.tableTentConfig || {};
  const [callToAction, setCallToAction] = useState(initialConfig.callToAction || 'Отсканируй, чтобы сделать заказ или вызвать официанта');
  const [footerText, setFooterText] = useState(initialConfig.footerText || 'Для меню, вызова официанта и чаевых');
  const [bgImage, setBgImage] = useState<string>(initialConfig.bgImage || '');
  const [bgOpacity, setBgOpacity] = useState(initialConfig.bgOpacity ?? 1);
  const [textColor, setTextColor] = useState(initialConfig.textColor || '#ffffff');
  const [qrColor, setQrColor] = useState(initialConfig.qrColor || '#000000');
  const [qrBgColor, setQrBgColor] = useState(initialConfig.qrBgColor || '#ffffff');
  const [qrScale, setQrScale] = useState(initialConfig.qrScale ?? 1);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const response = await fetch("/api/admin/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${localStorage.getItem("admin_token")}`,
          "Content-Type": file.type
        },
        body: file
      });
      
      if (!response.ok) {
        throw new Error("Failed to upload image");
      }
      
      const data = await response.json();
      setBgImage(data.url);
    } catch (error) {
      alert("Ошибка при загрузке изображения");
      console.error(error);
    } finally {
      setIsUploading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleSaveTemplate = async () => {
    setIsSaving(true);
    try {
      const updatedSettings = {
        ...settings,
        tableTentConfig: {
          callToAction,
          footerText,
          bgImage,
          bgOpacity,
          textColor,
          qrColor,
          qrBgColor,
          qrScale
        }
      };

      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${localStorage.getItem("admin_token")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updatedSettings)
      });
      
      if (!response.ok) throw new Error("Failed to save settings");
      
      alert("Шаблон успешно сохранен!");
    } catch (error) {
      alert("Ошибка при сохранении шаблона");
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePrint = () => {
    document.body.classList.add('print-single-mode');
    window.print();
    document.body.classList.remove('print-single-mode');
  };

  const handlePrintAll = () => {
    document.body.classList.add('print-all-mode');
    window.print();
    document.body.classList.remove('print-all-mode');
  };

  const renderTent = (table: Table) => {
    const url = `${publicUrl}/t/${table.slug}`;
    return (
      <div className="table-tent-canvas" key={table.id} style={{ color: textColor }}>
        {/* Background Layer */}
        <div 
          className="table-tent-bg" 
          style={{ 
            backgroundImage: bgImage ? `url(${bgImage})` : 'none',
            opacity: bgOpacity,
            backgroundColor: bgImage ? 'transparent' : 'var(--brand-main)'
          }} 
        />

        {/* Content Layer */}
        <div className="table-tent-content">
          <div className="table-tent-header" style={{ marginBottom: 'auto' }}>
            {/* Logo removed per user request, background has the logo */}
          </div>

          <div className="table-tent-middle">
            <h1 className="table-tent-cta">{callToAction}</h1>
            
            <div className="table-tent-qr-container" style={{ backgroundColor: qrBgColor, transform: `scale(${qrScale})`, transformOrigin: 'center' }}>
              <FancyQRCode 
                url={url} 
                logoUrl={settings.logoUrl}
                qrColor={qrColor}
                qrBgColor={qrBgColor}
              />
            </div>

            <div className="table-tent-table-name">
              {table.name}
            </div>
          </div>

          <div className="table-tent-footer">
            {footerText}
          </div>
        </div>
      </div>
    );
  };

  const qrUrl = selectedTable ? `${publicUrl}/t/${selectedTable.slug}` : publicUrl;

  return (
    <div className="table-tent-designer">
      <div className="designer-controls no-print">
        <div className="admin-card">
          <div className="admin-card-header">
            <h3><LayoutTemplate size={20} /> Настройки макета</h3>
          </div>
          <div className="admin-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            <div className="form-group">
              <label>Выберите стол для генерации QR-кода</label>
              <select 
                value={selectedTable?.id || ''} 
                onChange={(e) => setSelectedTable(tables.find(t => t.id === e.target.value) || null)}
                className="form-input"
              >
                {tables.map(t => (
                  <option key={t.id} value={t.id}>{t.name} (ID: {t.slug})</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label><Type size={16} style={{display: 'inline', verticalAlign: 'text-bottom', marginRight: '4px'}}/> Призыв к действию (Верхний текст)</label>
              <textarea 
                value={callToAction}
                onChange={(e) => setCallToAction(e.target.value)}
                className="form-input"
                rows={2}
                placeholder="Например: Отсканируй, чтобы вызвать официанта"
              />
            </div>

            <div className="form-group">
              <label><Type size={16} style={{display: 'inline', verticalAlign: 'text-bottom', marginRight: '4px'}}/> Инструкция (Нижний текст)</label>
              <textarea 
                value={footerText}
                onChange={(e) => setFooterText(e.target.value)}
                className="form-input"
                rows={2}
                placeholder="Например: Для меню, вызова официанта и чаевых"
              />
            </div>

            <div className="form-group">
              <label><ImageIcon size={16} style={{display: 'inline', verticalAlign: 'text-bottom', marginRight: '4px'}}/> Фоновое изображение</label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="secondary-button" onClick={() => fileInputRef.current?.click()} style={{ flex: 1 }}>
                  <Upload size={16} /> Загрузить фон
                </button>
                {bgImage && (
                  <button className="danger-button" onClick={() => setBgImage('')} style={{ padding: '0 16px' }}>
                    Удалить
                  </button>
                )}
              </div>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleImageUpload} 
                accept="image/*" 
                style={{ display: 'none' }} 
              />
            </div>

            <div className="form-group">
              <label><SlidersHorizontal size={16} style={{display: 'inline', verticalAlign: 'text-bottom', marginRight: '4px'}}/> Прозрачность фона: {Math.round(bgOpacity * 100)}%</label>
              <input 
                type="range" 
                min="0.1" 
                max="1" 
                step="0.05" 
                value={bgOpacity} 
                onChange={(e) => setBgOpacity(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
            </div>

            <div className="form-group">
              <label><SlidersHorizontal size={16} style={{display: 'inline', verticalAlign: 'text-bottom', marginRight: '4px'}}/> Размер QR-блока: {Math.round(qrScale * 100)}%</label>
              <input 
                type="range" 
                min="0.5" 
                max="1.5" 
                step="0.05" 
                value={qrScale} 
                onChange={(e) => setQrScale(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
            </div>

            <div className="form-group" style={{ display: 'flex', gap: '20px' }}>
              <div style={{ flex: 1 }}>
                <label>Цвет текста</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} />
                  <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{textColor}</span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label>Цвет QR-кода</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input type="color" value={qrColor} onChange={e => setQrColor(e.target.value)} />
                  <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{qrColor}</span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label>Фон QR-кода</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input type="color" value={qrBgColor} onChange={e => setQrBgColor(e.target.value)} />
                  <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{qrBgColor}</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px', flexDirection: 'column' }}>
              <button 
                className="primary-button" 
                onClick={handleSaveTemplate}
                disabled={isSaving || isUploading}
                style={{ backgroundColor: 'var(--brand-accent)' }}
              >
                {isSaving ? "Сохранение..." : isUploading ? "Загрузка изображения..." : "💾 Сохранить шаблон (Фон и настройки)"}
              </button>
              
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="primary-button" onClick={handlePrintAll} style={{ flex: 1 }}>
                  <Printer size={20} /> Скачать для ВСЕХ столов (PDF)
                </button>
                <button className="secondary-button" onClick={handlePrint} style={{ flex: 1 }}>
                  <Printer size={20} /> Печать одного
                </button>
              </div>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>
              Для скачивания нажмите кнопку, в появившемся окне выберите принтер <strong>"Сохранить как PDF"</strong>, формат <strong>A5</strong> (масштаб 100%), без колонтитулов.
            </p>

          </div>
        </div>
      </div>

      <div className="designer-preview-wrapper">
        <div className="designer-preview-label no-print">Предпросмотр (А5 Вертикальный)</div>
        {selectedTable ? renderTent(selectedTable) : null}
      </div>

      <div className="print-all-container">
        {tables.map(table => renderTent(table))}
      </div>
    </div>
  );
}
