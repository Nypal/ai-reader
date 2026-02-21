import { BookOpen } from 'lucide-react';
import './Header.css';

export default function Header() {

    return (
        <header className="app-header">
            <div className="container header-container">
                <div className="logo-section">
                    <BookOpen className="logo-icon" size={28} />
                    <h1 className="logo-text">NeuralReader</h1>
                </div>

                <div className="header-actions">
                    {/* Theme switcher moved to InputView */}
                </div>
            </div>
        </header>
    );
}
