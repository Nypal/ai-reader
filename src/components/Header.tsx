import { BookOpen } from 'lucide-react';
import './Header.css';

interface HeaderProps {
    onHome?: () => void;
}

export default function Header({ onHome }: HeaderProps) {

    return (
        <header className="app-header">
            <div className="container header-container">
                <div
                    className={`logo-section ${onHome ? 'clickable' : ''}`}
                    onClick={onHome}
                    title={onHome ? "Return home" : undefined}
                >
                    <BookOpen className="logo-icon" size={28} />
                    <h1 className="logo-text">Alphie</h1>
                </div>

                <div className="header-actions">
                    {/* Theme switcher moved to InputView */}
                </div>
            </div>
        </header>
    );
}
