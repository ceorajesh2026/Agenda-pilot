// Small header widget: shows who's signed in and a Sign out button. Non-admins also get a
// "Change password" link (routes to #/settings, which renders the password-only view for them).
import { useAuth } from '../lib/auth';

export default function AccountMenu() {
  const { me, email, logout } = useAuth();
  const label = me?.user.name?.trim() || me?.user.email || email || 'Account';

  return (
    <div className="account-menu" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="muted" style={{ fontSize: 12.5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={me?.user.email || email || ''}>
        {label}
      </span>
      {me && !me.user.is_admin && (
        <button className="btn sm" onClick={() => { window.location.hash = '#/settings'; }}>Account</button>
      )}
      <button className="btn sm" onClick={logout}>Sign out</button>
    </div>
  );
}
